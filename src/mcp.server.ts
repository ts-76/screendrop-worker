import { McpServer } from "@modelcontextprotocol/server"
import { createMcpHandler } from "agents/mcp/server"
import { and, desc, eq, like, or } from "drizzle-orm"
import { z } from "zod"
import type { McpIdentity } from "@/lib/mcp-access.server"
import {
  afterSearchCursor,
  decodeSearchCursor,
  encodeSearchCursor,
} from "@/lib/mcp-pagination"
import { db } from "@/db"
import { uploads } from "@/db/schema"
import { verifyMcpAccessAssertion } from "@/lib/mcp-access.server"

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 256 * 1024
const MAX_PAGE_SIZE = 50
const BASE64_CHUNK_BYTES = 32 * 1024

type McpContext = {
  env: Env
  identity: McpIdentity
  request: Request
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  }
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES),
    )
  return btoa(binary)
}

function safeId(value: string): string | null {
  const id = value.trim()
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null
}

function createServer(context: McpContext): McpServer {
  const server = new McpServer({ name: "screendrop", version: "1.0.0" })
  const id = z.string().min(1).max(128)

  server.registerTool(
    "search_captures",
    {
      description: "Search capture metadata. This tool never changes data.",
      inputSchema: {
        query: z.string().trim().max(200).optional(),
        mediaType: z.string().trim().max(32).optional(),
        cursor: z.string().max(512).optional(),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, mediaType, cursor, limit }) => {
      const pageSize = limit ?? 20
      const decodedCursor = decodeSearchCursor(cursor)
      if (cursor && !decodedCursor) return errorResult("Invalid cursor")
      const conditions = []
      if (query) {
        const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
        conditions.push(or(like(uploads.title, pattern), like(uploads.filename, pattern)))
      }
      if (mediaType) conditions.push(eq(uploads.mediaType, mediaType))
      if (decodedCursor)
        conditions.push(
          afterSearchCursor(
            decodedCursor,
            uploads.createdAt,
            uploads.id,
          ),
        )
      const rows = await db
        .select({
          id: uploads.id,
          filename: uploads.filename,
          title: uploads.title,
          contentType: uploads.contentType,
          mediaType: uploads.mediaType,
          size: uploads.size,
          width: uploads.width,
          height: uploads.height,
          duration: uploads.duration,
          createdAt: uploads.createdAt,
        })
        .from(uploads)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(uploads.createdAt), desc(uploads.id))
        .limit(pageSize + 1)
      const hasMore = rows.length > pageSize
      const page = hasMore ? rows.slice(0, pageSize) : rows
      return textResult({
        captures: page,
        nextCursor:
          hasMore && page.at(-1)
            ? encodeSearchCursor({
                createdAt: page.at(-1)!.createdAt,
                id: page.at(-1)!.id,
              })
            : null,
      })
    },
  )

  server.registerTool(
    "get_capture",
    {
      description: "Get metadata and available sidecars for one capture.",
      inputSchema: { id },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ id: rawId }) => {
      const captureId = safeId(rawId)
      if (!captureId) return errorResult("Invalid capture id")
      const capture = await db.query.uploads.findFirst({
        where: eq(uploads.id, captureId),
      })
      if (!capture) return errorResult("Capture not found")
      return textResult({
        id: capture.id,
        filename: capture.filename,
        title: capture.title,
        contentType: capture.contentType,
        mediaType: capture.mediaType,
        size: capture.size,
        width: capture.width,
        height: capture.height,
        duration: capture.duration,
        createdAt: capture.createdAt,
        views: capture.views,
        sidecars: {
          poster: Boolean(capture.posterKey),
          transcript: Boolean(capture.transcriptKey),
          storyboard: Boolean(capture.storyboardKey),
        },
      })
    },
  )

  server.registerTool(
    "get_image",
    {
      description: "Read a bounded image or poster representation.",
      inputSchema: { id, asset: z.enum(["original", "poster"]).optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ id: rawId, asset = "original" }) => {
      const captureId = safeId(rawId)
      if (!captureId) return errorResult("Invalid capture id")
      const capture = await db.query.uploads.findFirst({
        where: eq(uploads.id, captureId),
      })
      if (
        !capture ||
        (asset === "original" && !capture.contentType.startsWith("image/"))
      )
        return errorResult("Image not found")
      const key = asset === "poster" ? capture.posterKey : capture.r2Key
      if (!key) return errorResult("Image not found")
      const object = await context.env.BUCKET.get(key)
      if (!object) return errorResult("Image not found")
      if (object.size > MAX_IMAGE_BYTES)
        return errorResult("Image exceeds the MCP size limit")
      const bytes = new Uint8Array(await object.arrayBuffer())
      const mimeType =
        object.httpMetadata?.contentType ??
        (asset === "poster" ? "image/jpeg" : capture.contentType)
      if (!mimeType.startsWith("image/")) return errorResult("Image not found")
      return {
        content: [
          {
            type: "image" as const,
            data: bytesToBase64(bytes),
            mimeType,
          },
        ],
      }
    },
  )

  server.registerTool(
    "get_transcript",
    {
      description: "Read the transcript sidecar for one capture.",
      inputSchema: { id },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ id: rawId }) => {
      const captureId = safeId(rawId)
      if (!captureId) return errorResult("Invalid capture id")
      const capture = await db.query.uploads.findFirst({
        where: eq(uploads.id, captureId),
      })
      if (!capture?.transcriptKey) return errorResult("Transcript not found")
      const object = await context.env.BUCKET.get(capture.transcriptKey)
      if (!object) return errorResult("Transcript not found")
      if (object.size > MAX_TRANSCRIPT_BYTES)
        return errorResult("Transcript exceeds the MCP size limit")
      try {
        return textResult(await object.json())
      } catch {
        return errorResult("Transcript is not valid JSON")
      }
    },
  )

  server.registerTool(
    "get_download_link",
    {
      description: "Return a public read-only media URL for one capture.",
      inputSchema: { id },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ id: rawId }) => {
      const captureId = safeId(rawId)
      if (!captureId) return errorResult("Invalid capture id")
      const exists = await db.query.uploads.findFirst({
        columns: { id: true },
        where: eq(uploads.id, captureId),
      })
      if (!exists) return errorResult("Capture not found")
      return textResult({
        id: captureId,
        url: new URL(`/api/media/${encodeURIComponent(captureId)}`, context.request.url).toString(),
      })
    },
  )

  return server
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== "https:" || url.pathname !== "/mcp")
    return new Response("Not found", { status: 404 })
  const rateLimit = Reflect.get(env, "MCP_RATE_LIMIT") as RateLimit | undefined
  if (!rateLimit)
    return new Response("MCP rate limit is not configured", { status: 503 })
  const identity = await verifyMcpAccessAssertion(
    request.headers.get("Cf-Access-Jwt-Assertion"),
    env,
  )
  if (!identity)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": 'Bearer realm="mcp"',
      },
    })
  const limited = await rateLimit.limit({
    key: `mcp:${identity.subject}`,
  })
  if (!limited.success)
    return new Response("Too many requests", {
      status: 429,
      headers: { "cache-control": "no-store", "retry-after": "60" },
    })
  const handler = createMcpHandler(() =>
    createServer({ env, identity, request }),
  )
  return handler(request, env, ctx)
}
