import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = require(
  require.resolve("esbuild", { paths: [require.resolve("wrangler")] }),
);

async function validator() {
  const bundle = await build({
    entryPoints: ["src/lib/library-upload-validation.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
}

function headers(overrides = {}) {
  return new Headers({
    "content-type": "image/png",
    "x-filename": encodeURIComponent("撮影画像.png"),
    "x-upload-size": "4094",
    ...overrides,
  });
}

test("browser upload accepts bounded raster images and optional classification", async () => {
  const { validateLibraryUploadHeaders } = await validator();
  const result = validateLibraryUploadHeaders(
    headers({
      "x-tag-id": "08836bbc-34b0-4067-a877-bb1dc66ba5cd",
      "x-collection-id": "5fa17529-abf0-419c-a887-90c9f7e939ee",
      "content-length": "4094",
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    value: {
      filename: "撮影画像.png",
      contentType: "image/png",
      advertisedSize: 4094,
      tagId: "08836bbc-34b0-4067-a877-bb1dc66ba5cd",
      collectionId: "5fa17529-abf0-419c-a887-90c9f7e939ee",
    },
  });
});

test("browser upload rejects unsafe names, types, sizes, and IDs", async () => {
  const { validateLibraryUploadHeaders } = await validator();
  const cases = [
    [{ "x-filename": encodeURIComponent("../bad.png") }, 400],
    [{ "x-filename": encodeURIComponent("line\nbreak.png") }, 400],
    [{ "x-filename": "%broken" }, 400],
    [{ "content-type": "image/svg+xml" }, 415],
    [{ "x-upload-size": "0" }, 400],
    [{ "x-upload-size": "90000001" }, 413],
    [{ "content-length": "4095" }, 400],
    [{ "x-tag-id": "unknown" }, 400],
    [{ "x-collection-id": "../../bad" }, 400],
  ];
  for (const [overrides, status] of cases) {
    assert.equal(
      validateLibraryUploadHeaders(headers(overrides)).status,
      status,
    );
  }
});
