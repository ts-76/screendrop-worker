import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("the Worker boundary denies AI crawlers, publishes robots policy, and rate-limits by IP", async () => {
  const worker = await source("src/worker.ts");
  assert.match(worker, /AI_CRAWLER_PATTERN/);
  assert.match(worker, /url\.pathname === "\/robots\.txt"/);
  assert.match(worker, /env\.RATE_LIMIT/);
  assert.match(worker, /cf-connecting-ip/);
  assert.match(worker, /x-robots-tag/);
  assert.match(worker, /isPublicRead/);
  assert.match(worker, /request\.method !== "GET"/);
  assert.match(worker, /url\.pathname === "\/mcp"/);
  assert.match(
    worker,
    /serverEntry\.fetch\(request, \{ context: \{ env, ctx \} \}\)/,
  );
  assert.match(worker, /cache-control/);
  assert.match(worker, /headers\.delete\("cloudflare-cdn-cache-control"\)/);
  assert.ok(
    worker.indexOf("if (isPublicRead(request, url.pathname))") <
      worker.indexOf("env.RATE_LIMIT.limit"),
    "mutation handlers must not enter the public-read limiter",
  );
  assert.ok(
    worker.indexOf('url.pathname === "/mcp"') <
      worker.indexOf("AI_CRAWLER_PATTERN.test"),
    "MCP must be routed before crawler denial",
  );
});

test("R2 reads are guarded and public responses use bounded cache TTLs", async () => {
  const media = await source("src/lib/media-response.server.ts");
  const budget = await source("src/lib/r2-budget.server.ts");
  const mcp = await source("src/mcp.server.ts");
  const config = await source("wrangler.jsonc");
  assert.match(media, /guardedR2Get/);
  assert.match(media, /caches as unknown as \{ default: Cache \}/);
  assert.match(media, /waitUntil/);
  assert.match(media, /max-age=0, s-maxage/);
  assert.doesNotMatch(media, /cloudflare-cdn-cache-control/);
  assert.match(media, /headers: \{ range \}/);
  assert.match(media, /\.match/);
  assert.match(media, /request\.method === "HEAD"/);
  assert.match(media, /parseRange/);
  assert.match(media, /private, no-store/);
  assert.match(media, /env\.CACHE_TTL_SECONDS/);
  assert.match(budget, /R2_BUDGET/);
  assert.match(budget, /R2BudgetExceededError/);
  assert.match(budget, /R2BudgetUnavailableError/);
  assert.match(budget, /result\.allowed/);
  assert.match(mcp, /guardedR2Get/);
  assert.doesNotMatch(mcp, /context\.env\.BUCKET\.get/);
  const durableObject = await source("src/durable-objects/r2-budget.ts");
  assert.match(durableObject, /storage\.transaction\(async \(txn\)/);
  assert.match(durableObject, /txn\.get/);
  assert.match(durableObject, /txn\.put/);
  assert.match(durableObject, /budget_unavailable/);
  assert.match(
    media,
    /if \(!row\) return noStore\(new Response\("Not found", \{ status: 404 \}\)\)/,
  );
  assert.match(config, /R2_DAILY_READ_LIMIT/);
  assert.match(config, /R2_MONTHLY_READ_LIMIT/);
  assert.match(config, /new_sqlite_classes/);
  assert.doesNotMatch(config, /"cache"/);
});

test("public media routes expose HEAD and preserve safe range behavior", async () => {
  for (const path of [
    "src/routes/api/image.$id.ts",
    "src/routes/api/media.$id.ts",
    "src/routes/api/poster.$id.ts",
    "src/routes/api/storyboard.$id.ts",
    "src/routes/api/captions.$id.ts",
    "src/routes/api/storyboard-vtt.$id.ts",
  ]) {
    const content = await source(path);
    assert.match(content, /HEAD:/);
  }
  const media = await source("src/lib/media-response.server.ts");
  assert.match(media, /status: 206/);
  assert.match(media, /content-range/);
});

test("the default vars example keeps optional auth and MCP opt-in empty", async () => {
  const vars = await source(".dev.vars.example");
  assert.doesNotMatch(vars, /(?:GITHUB|GOOGLE)_CLIENT_(?:ID|SECRET)/);
  assert.doesNotMatch(
    vars,
    /MCP_ACCESS_(?:TEAM_DOMAIN|ISSUER|JWKS_URL|AUDIENCE)/,
  );
});

test("all public media route handlers pass the request to cache-aware serving", async () => {
  for (const path of [
    "src/routes/api/image.$id.ts",
    "src/routes/api/media.$id.ts",
    "src/routes/api/poster.$id.ts",
    "src/routes/api/storyboard.$id.ts",
  ]) {
    const content = await source(path);
    assert.match(content, /request/);
  }
});
