import { env, waitUntil } from "cloudflare:workers";
import { withCors } from "@/lib/api.server";
import {
  R2BudgetExceededError,
  R2BudgetUnavailableError,
  guardedR2Get,
} from "@/lib/r2-budget.server";

export interface ByteRange {
  offset: number;
  length: number;
}

export function parseRange(header: string, size: number): ByteRange | null {
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !/^bytes=[^,]+$/.test(header.trim())
  )
    return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw !== "") {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  if (startRaw === "") return null;
  const offset = Number(startRaw);
  if (!Number.isSafeInteger(offset) || offset >= size) return null;
  const end = endRaw === "" ? size - 1 : Number(endRaw);
  if (!Number.isSafeInteger(end) || end < offset) return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

function cacheTtl(): number {
  const parsed = Number(env.CACHE_TTL_SECONDS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return withCors(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

export function publicCacheHeaders(headers: Headers): void {
  const ttl = cacheTtl();
  if (!ttl) {
    headers.set("cache-control", "private, no-store");
    return;
  }
  headers.set(
    "cache-control",
    `public, max-age=0, s-maxage=${ttl}, must-revalidate`,
  );
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set("x-content-type-options", "nosniff");
}

function budgetFailure(error: unknown): Response | null {
  if (
    !(error instanceof R2BudgetExceededError) &&
    !(error instanceof R2BudgetUnavailableError)
  )
    return null;
  const headers = new Headers({ "cache-control": "private, no-store" });
  if (error instanceof R2BudgetExceededError)
    headers.set("retry-after", String(error.retryAfter));
  return withCors(
    new Response("R2 read unavailable", {
      status: error instanceof R2BudgetExceededError ? 429 : 503,
      headers,
    }),
  );
}

function cacheKey(request: Request): Request {
  return new Request(request.url, { method: "GET" });
}

async function cachedResponse(request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const range = request.headers.get("range");
  // Cache API can derive a 206 response from a cached full response for GET
  // Range requests. HEAD+Range is handled by the R2 path below.
  if (request.method === "HEAD" && range) return null;
  try {
    const response =
      (await (caches as unknown as { default: Cache }).default.match(
        range
          ? new Request(request.url, {
              method: "GET",
              headers: { range },
            })
          : cacheKey(request),
      )) ?? null;
    if (!response || request.method !== "HEAD") return response;
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    return null;
  }
}

function storeResponse(request: Request, response: Response): void {
  try {
    const put = (caches as unknown as { default: Cache }).default.put(
      cacheKey(request),
      response,
    );
    waitUntil(put.catch(() => undefined));
  } catch {
    /* Cache is optional. */
  }
}

export async function serveMedia(
  id: string,
  request: Request,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT r2_key, content_type, size FROM uploads WHERE id = ?",
  )
    .bind(id)
    .first<{ r2_key: string; content_type: string; size: number }>();
  if (!row) return noStore(new Response("Not found", { status: 404 }));
  const hit = await cachedResponse(request);
  if (hit) return withCors(hit);
  const requestedRange = request.headers.get("range");
  try {
    const range = requestedRange ? parseRange(requestedRange, row.size) : null;
    if (requestedRange && !range)
      return noStore(
        new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "content-range": `bytes */${row.size}` },
        }),
      );
    const object = await guardedR2Get(
      row.r2_key,
      range ? { range } : undefined,
    );
    if (!object)
      return noStore(new Response("Not found", { status: 404 }));
    if (range) {
      const headers = new Headers({
        "content-type": row.content_type,
        etag: object.httpEtag,
        "accept-ranges": "bytes",
        "content-length": String(range.length),
        "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`,
      });
      return withCors(
        new Response(request.method === "HEAD" ? null : object.body, {
          status: 206,
          headers,
        }),
      );
    }
    const headers = new Headers({
      "content-type": row.content_type,
      etag: object.httpEtag,
      "accept-ranges": "bytes",
      "content-length": String(row.size),
    });
    publicCacheHeaders(headers);
    const response = new Response(
      request.method === "HEAD" ? null : object.body,
      { headers },
    );
    if (request.method === "GET") storeResponse(request, response.clone());
    return withCors(response);
  } catch (error) {
    return (
      budgetFailure(error) ??
      noStore(new Response("Internal server error", { status: 500 }))
    );
  }
}

export async function serveAsset(
  r2Key: string | null,
  contentType: string,
  request: Request,
): Promise<Response> {
  if (!r2Key) return noStore(new Response("Not found", { status: 404 }));
  const hit = await cachedResponse(request);
  if (hit) return withCors(hit);
  try {
    const object = await guardedR2Get(r2Key);
    if (!object)
      return noStore(new Response("Not found", { status: 404 }));
    const headers = new Headers({
      "content-type": contentType,
      etag: object.httpEtag,
    });
    publicCacheHeaders(headers);
    const response = new Response(
      request.method === "HEAD" ? null : object.body,
      { headers },
    );
    if (request.method === "GET") storeResponse(request, response.clone());
    return withCors(response);
  } catch (error) {
    return (
      budgetFailure(error) ??
      noStore(new Response("Internal server error", { status: 500 }))
    );
  }
}
