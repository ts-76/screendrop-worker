import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = require(
  require.resolve("esbuild", { paths: [require.resolve("wrangler")] }),
);

async function sessionModule() {
  const bundle = await build({
    entryPoints: ["src/lib/library-session.server.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
}

test("library session is signed, scoped, and expires", async () => {
  const { createLibraryCookie, hasLibrarySession, clearLibraryCookie } =
    await sessionModule();
  const secret = "unit-test-secret-0123456789";
  const setCookie = await createLibraryCookie(secret);
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=43200/);
  assert.ok(!setCookie.includes(secret));

  const value = setCookie.split(";")[0];
  const request = (cookie) =>
    new Request("https://example.com/api/library/metadata", {
      headers: { cookie },
    });
  assert.equal(await hasLibrarySession(request(value), secret), true);
  assert.equal(
    await hasLibrarySession(request(value), `${secret}-other`),
    false,
  );
  assert.equal(
    await hasLibrarySession(request(value.replace(/.$/, "x")), secret),
    false,
  );
  assert.equal(await hasLibrarySession(request(""), secret), false);
  assert.match(clearLibraryCookie(), /Max-Age=0/);

  const oldNow = Date.now;
  try {
    Date.now = () => oldNow() + 13 * 60 * 60 * 1000;
    assert.equal(await hasLibrarySession(request(value), secret), false);
  } finally {
    Date.now = oldNow;
  }
});

test("library mutations require a matching Origin and reject oversized JSON", async () => {
  const { sameOrigin, readSmallJson, validLibraryToken } =
    await sessionModule();
  assert.equal(
    sameOrigin(
      new Request("https://example.com/api/library/tags", {
        method: "POST",
        headers: { origin: "https://example.com" },
      }),
    ),
    true,
  );
  assert.equal(
    sameOrigin(
      new Request("https://example.com/api/library/tags", {
        method: "POST",
        headers: { origin: "https://elsewhere.example" },
      }),
    ),
    false,
  );
  assert.equal(
    sameOrigin(
      new Request("https://example.com/api/library/tags", {
        method: "POST",
      }),
    ),
    false,
  );
  assert.equal(await validLibraryToken("correct", "correct"), true);
  assert.equal(await validLibraryToken("incorrect", "correct"), false);
  assert.equal(await validLibraryToken("anything", ""), false);
  assert.deepEqual(
    await readSmallJson(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ name: "Design" }),
      }),
    ),
    { name: "Design" },
  );
  assert.equal(
    await readSmallJson(
      new Request("https://example.com", {
        method: "POST",
        body: "x".repeat(2049),
      }),
    ),
    null,
  );
});
