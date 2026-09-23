import { decodeSearchCursor, encodeSearchCursor } from "@/lib/mcp-pagination";
import {
  clearLibraryCookie,
  createLibraryCookie,
  hasLibrarySession,
  privateJson,
  readSmallJson,
  sameOrigin,
  validLibraryToken,
} from "@/lib/library-session.server";
import { ensureSchema } from "@/lib/uploads.server";
import { handleLibraryUpload } from "@/lib/library-upload.server";

const PAGE_SIZE = 24;
const MAX_RELATIONS = 30;
const ID_PATTERN = /^[a-z0-9-]{8,40}$/;

type CaptureRow = {
  id: string;
  filename: string;
  title: string | null;
  contentType: string;
  mediaType: string;
  size: number;
  createdAt: string;
  posterKey: string | null;
};

type NamedRow = { id: string; name: string; count: number };
type CaptureRelation = { uploadId: string; id: string; name: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedName(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= maxLength ? name : null;
}

function isId(value: string | undefined): value is string {
  return Boolean(value && ID_PATTERN.test(value));
}

function success(body: unknown, status = 200): Response {
  return privateJson(body, status);
}

function failure(message: string, status: number): Response {
  return privateJson({ error: message }, status);
}

async function sessionEndpoint(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return success({
      authenticated: await hasLibrarySession(request, env.UPLOAD_TOKEN),
    });
  }
  if (!sameOrigin(request)) return failure("Forbidden", 403);
  if (request.method === "DELETE") {
    return Response.json(
      { authenticated: false },
      {
        headers: {
          "cache-control": "private, no-store",
          "set-cookie": clearLibraryCookie(),
        },
      },
    );
  }
  if (request.method !== "POST") return failure("Method not allowed", 405);

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const limited = await env.LIBRARY_LOGIN_RATE_LIMIT.limit({
    key: `library:${ip}`,
  });
  if (!limited.success) {
    return Response.json(
      { error: "Too many attempts. Try again later." },
      {
        status: 429,
        headers: { "cache-control": "private, no-store", "retry-after": "60" },
      },
    );
  }
  const body = await readSmallJson(request);
  if (
    !isObject(body) ||
    typeof body.token !== "string" ||
    body.token.length > 512
  ) {
    return failure("Invalid request", 400);
  }
  if (!(await validLibraryToken(body.token, env.UPLOAD_TOKEN))) {
    return failure("Invalid token", 401);
  }
  await ensureSchema();
  return Response.json(
    { authenticated: true },
    {
      headers: {
        "cache-control": "private, no-store",
        "set-cookie": await createLibraryCookie(env.UPLOAD_TOKEN),
      },
    },
  );
}

async function listMetadata(env: Env): Promise<Response> {
  const [tagRows, collectionRows] = await Promise.all([
    env.DB.prepare(
      "SELECT t.id, t.name, COUNT(ut.upload_id) AS count FROM tags t LEFT JOIN upload_tags ut ON ut.tag_id = t.id GROUP BY t.id ORDER BY lower(t.name), t.id",
    ).all<NamedRow>(),
    env.DB.prepare(
      "SELECT c.id, c.name, COUNT(cu.upload_id) AS count FROM collections c LEFT JOIN collection_uploads cu ON cu.collection_id = c.id GROUP BY c.id ORDER BY lower(c.name), c.id",
    ).all<NamedRow>(),
  ]);
  return success({
    tags: tagRows.results,
    collections: collectionRows.results,
  });
}

async function listCaptures(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  if (query.length > 100) return failure("Search is too long", 400);
  const mediaType = params.get("type") ?? "all";
  if (!["all", "image", "video"].includes(mediaType))
    return failure("Invalid media type", 400);
  const tagId = params.get("tag") ?? "";
  const collectionId = params.get("collection") ?? "";
  if ((tagId && !isId(tagId)) || (collectionId && !isId(collectionId))) {
    return failure("Invalid filter", 400);
  }
  const cursorValue = params.get("cursor") ?? "";
  const cursor = decodeSearchCursor(cursorValue);
  if (cursorValue && (!cursor || !isId(cursor.id)))
    return failure("Invalid cursor", 400);

  const where: Array<string> = [];
  const bindings: Array<string | number> = [];
  const joins: Array<string> = [];
  if (tagId) {
    joins.push(
      "JOIN upload_tags filter_tag ON filter_tag.upload_id = u.id AND filter_tag.tag_id = ?",
    );
    bindings.push(tagId);
  }
  if (collectionId) {
    joins.push(
      "JOIN collection_uploads filter_collection ON filter_collection.upload_id = u.id AND filter_collection.collection_id = ?",
    );
    bindings.push(collectionId);
  }
  if (mediaType !== "all") {
    where.push("u.media_type = ?");
    bindings.push(mediaType);
  }
  if (query) {
    where.push(
      "instr(lower(coalesce(u.title, '') || ' ' || u.filename), lower(?)) > 0",
    );
    bindings.push(query);
  }
  if (cursor) {
    where.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql = `SELECT u.id, u.filename, u.title, u.content_type AS contentType, u.media_type AS mediaType, u.size, u.created_at AS createdAt, u.poster_key AS posterKey FROM uploads u ${joins.join(" ")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`;
  const rows = await env.DB.prepare(sql)
    .bind(...bindings, PAGE_SIZE + 1)
    .all<CaptureRow>();
  const hasMore = rows.results.length > PAGE_SIZE;
  const page = rows.results.slice(0, PAGE_SIZE);
  if (page.length === 0) return success({ captures: [], nextCursor: null });

  const placeholders = page.map(() => "?").join(",");
  const ids = page.map((row) => row.id);
  const [tagRows, collectionRows] = await Promise.all([
    env.DB.prepare(
      `SELECT ut.upload_id AS uploadId, t.id, t.name FROM upload_tags ut JOIN tags t ON t.id = ut.tag_id WHERE ut.upload_id IN (${placeholders}) ORDER BY lower(t.name)`,
    )
      .bind(...ids)
      .all<CaptureRelation>(),
    env.DB.prepare(
      `SELECT cu.upload_id AS uploadId, c.id, c.name FROM collection_uploads cu JOIN collections c ON c.id = cu.collection_id WHERE cu.upload_id IN (${placeholders}) ORDER BY lower(c.name)`,
    )
      .bind(...ids)
      .all<CaptureRelation>(),
  ]);
  const captures = page.map((row) => ({
    ...row,
    tags: tagRows.results
      .filter((tag) => tag.uploadId === row.id)
      .map(({ id, name }) => ({ id, name })),
    collections: collectionRows.results
      .filter((collection) => collection.uploadId === row.id)
      .map(({ id, name }) => ({ id, name })),
  }));
  const last = page.at(-1)!;
  return success({
    captures,
    nextCursor: hasMore
      ? encodeSearchCursor({ createdAt: last.createdAt, id: last.id })
      : null,
  });
}

async function namedResource(
  request: Request,
  env: Env,
  kind: "tags" | "collections",
  id?: string,
): Promise<Response> {
  const table = kind === "tags" ? "tags" : "collections";
  const relation = kind === "tags" ? "upload_tags" : "collection_uploads";
  const relationColumn = kind === "tags" ? "tag_id" : "collection_id";
  if (id && !isId(id)) return failure("Invalid id", 400);

  if (request.method === "DELETE" && id) {
    const found = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`)
      .bind(id)
      .first();
    if (!found) return failure("Not found", 404);
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM ${relation} WHERE ${relationColumn} = ?`,
      ).bind(id),
      env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id),
    ]);
    return success({ deleted: true });
  }
  if (
    (!id && request.method !== "POST") ||
    (id && request.method !== "PATCH")
  ) {
    return failure("Method not allowed", 405);
  }
  const body = await readSmallJson(request);
  const name = isObject(body)
    ? normalizedName(body.name, kind === "tags" ? 40 : 80)
    : null;
  if (!name) return failure("Invalid name", 400);
  const nameKey = name.toLocaleLowerCase("en-US");
  if (id) {
    const found = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`)
      .bind(id)
      .first();
    if (!found) return failure("Not found", 404);
  }
  const conflict = await env.DB.prepare(
    `SELECT id FROM ${table} WHERE name_key = ?`,
  )
    .bind(nameKey)
    .first<{ id: string }>();
  if (conflict && conflict.id !== id)
    return failure("Name already exists", 409);
  const itemId = id ?? crypto.randomUUID();
  if (id) {
    await env.DB.prepare(
      `UPDATE ${table} SET name = ?, name_key = ? WHERE id = ?`,
    )
      .bind(name, nameKey, id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO ${table} (id, name, name_key) VALUES (?, ?, ?)`,
    )
      .bind(itemId, name, nameKey)
      .run();
  }
  return success({ id: itemId, name }, id ? 200 : 201);
}

async function replaceRelations(
  request: Request,
  env: Env,
  captureId: string,
  kind: "tags" | "collections",
): Promise<Response> {
  if (request.method !== "PUT") return failure("Method not allowed", 405);
  if (!isId(captureId)) return failure("Invalid capture id", 400);
  const body = await readSmallJson(request);
  const ids = isObject(body) ? body.ids : null;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_RELATIONS ||
    !ids.every((id) => typeof id === "string" && isId(id))
  ) {
    return failure("Invalid selection", 400);
  }
  const uniqueIds = [...new Set(ids)] as Array<string>;
  const upload = await env.DB.prepare("SELECT id FROM uploads WHERE id = ?")
    .bind(captureId)
    .first();
  if (!upload) return failure("Capture not found", 404);
  const table = kind === "tags" ? "tags" : "collections";
  const relation = kind === "tags" ? "upload_tags" : "collection_uploads";
  const relationColumn = kind === "tags" ? "tag_id" : "collection_id";
  if (uniqueIds.length > 0) {
    const placeholders = uniqueIds.map(() => "?").join(",");
    const found = await env.DB.prepare(
      `SELECT id FROM ${table} WHERE id IN (${placeholders})`,
    )
      .bind(...uniqueIds)
      .all<{ id: string }>();
    if (found.results.length !== uniqueIds.length)
      return failure("Selection contains an unknown item", 400);
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${relation} WHERE upload_id = ?`).bind(
      captureId,
    ),
    ...uniqueIds.map((id) =>
      env.DB.prepare(
        `INSERT INTO ${relation} (upload_id, ${relationColumn}) VALUES (?, ?)`,
      ).bind(captureId, id),
    ),
  ]);
  return success({ ids: uniqueIds });
}

export async function handleLibraryApi(
  request: Request,
  env: Env,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (path === "/api/library/session")
      return await sessionEndpoint(request, env);
    if (!(await hasLibrarySession(request, env.UPLOAD_TOKEN)))
      return failure("Unauthorized", 401);
    if (request.method !== "GET" && !sameOrigin(request))
      return failure("Forbidden", 403);
    if (path === "/api/library/metadata" && request.method === "GET")
      return await listMetadata(env);
    if (path === "/api/library/captures" && request.method === "GET")
      return await listCaptures(request, env);
    if (path === "/api/library/upload")
      return await handleLibraryUpload(request, env);

    const relationMatch =
      /^\/api\/library\/captures\/([^/]+)\/(tags|collections)$/.exec(path);
    if (relationMatch)
      return await replaceRelations(
        request,
        env,
        relationMatch[1],
        relationMatch[2] as "tags" | "collections",
      );
    const namedMatch =
      /^\/api\/library\/(tags|collections)(?:\/([^/]+))?$/.exec(path);
    if (namedMatch)
      return await namedResource(
        request,
        env,
        namedMatch[1] as "tags" | "collections",
        namedMatch[2],
      );
    return failure("Not found", 404);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Library API failed",
        path,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return failure("Internal server error", 500);
  }
}
