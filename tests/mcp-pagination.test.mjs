import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const { build } = require(
  require.resolve("esbuild", { paths: [require.resolve("wrangler")] }),
)

test("search cursor is a strict createdAt/id keyset", async () => {
  const bundle = await build({
    entryPoints: ["src/lib/mcp-pagination.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  })
  const {
    decodeSearchCursor,
    encodeSearchCursor,
    isAfterSearchCursor,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`,
  )
  const cursor = { createdAt: "2026-09-20 10:00:00", id: "capture-b" }
  const encoded = encodeSearchCursor(cursor)
  assert.deepEqual(decodeSearchCursor(encoded), cursor)
  assert.equal(isAfterSearchCursor(cursor, cursor), false)
  assert.equal(
    isAfterSearchCursor(
      { createdAt: "2026-09-20 10:00:00", id: "capture-a" },
      cursor,
    ),
    true,
  )
  assert.equal(
    isAfterSearchCursor(
      { createdAt: "2026-09-20 10:00:01", id: "capture-z" },
      cursor,
    ),
    false,
  )
  assert.equal(decodeSearchCursor(btoa("capture-b")), null)
})
