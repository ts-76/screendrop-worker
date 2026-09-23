import { privateJson } from "@/lib/library-session.server";
import { MAX_LIBRARY_UPLOAD_BYTES } from "@/lib/library-upload-config";
import { validateLibraryUploadHeaders } from "@/lib/library-upload-validation";
import { ensureSchema } from "@/lib/uploads.server";

// The shared 90 MB limit is below the 100 MB request-body limit of Free zones.

function failure(message: string, status: number): Response {
  return privateJson({ error: message }, status);
}

export async function handleLibraryUpload(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "PUT") return failure("Method not allowed", 405);
  if (!request.body) return failure("Image is required", 400);

  const validation = validateLibraryUploadHeaders(request.headers);
  if (!validation.ok) return failure(validation.error, validation.status);
  const { filename, contentType, advertisedSize, tagId, collectionId } =
    validation.value;

  await ensureSchema();
  if (tagId) {
    const tag = await env.DB.prepare("SELECT id FROM tags WHERE id = ?")
      .bind(tagId)
      .first();
    if (!tag) return failure("Tag not found", 400);
  }
  if (collectionId) {
    const collection = await env.DB.prepare(
      "SELECT id FROM collections WHERE id = ?",
    )
      .bind(collectionId)
      .first();
    if (!collection) return failure("Collection not found", 400);
  }

  const id = crypto.randomUUID().split("-")[0];
  const r2Key = `uploads/${id}/original`;
  // Preserve a known length for R2 while streaming without buffering the
  // image in Worker memory. FixedLengthStream also rejects short/long bodies.
  const fixed = new FixedLengthStream(advertisedSize);
  const pumping = request.body.pipeTo(fixed.writable);
  const storing = env.BUCKET.put(r2Key, fixed.readable, {
    httpMetadata: { contentType },
    customMetadata: { originalName: filename },
  });
  const [storeResult, pumpResult] = await Promise.allSettled([
    storing,
    pumping,
  ]);
  if (pumpResult.status === "rejected") {
    if (storeResult.status === "fulfilled") await env.BUCKET.delete(r2Key);
    return failure("Image size did not match the request", 400);
  }
  if (storeResult.status === "rejected") throw storeResult.reason;
  const stored = storeResult.value;
  if (stored.size > MAX_LIBRARY_UPLOAD_BYTES) {
    await env.BUCKET.delete(r2Key);
    return failure("Image exceeds the 90 MB upload limit", 413);
  }
  if (stored.size !== advertisedSize) {
    await env.BUCKET.delete(r2Key);
    return failure("Image size did not match the request", 400);
  }

  try {
    const statements = [
      env.DB.prepare(
        "INSERT INTO uploads (id, filename, content_type, size, r2_key, media_type, social_enabled) VALUES (?, ?, ?, ?, ?, 'image', 1)",
      ).bind(id, filename, contentType, stored.size, r2Key),
    ];
    if (tagId)
      statements.push(
        env.DB.prepare(
          "INSERT INTO upload_tags (upload_id, tag_id) VALUES (?, ?)",
        ).bind(id, tagId),
      );
    if (collectionId)
      statements.push(
        env.DB.prepare(
          "INSERT INTO collection_uploads (collection_id, upload_id) VALUES (?, ?)",
        ).bind(collectionId, id),
      );
    await env.DB.batch(statements);
  } catch (error) {
    try {
      await env.BUCKET.delete(r2Key);
    } catch (cleanupError) {
      console.error(
        JSON.stringify({
          message: "Library upload cleanup failed",
          r2Key,
          error: String(cleanupError),
        }),
      );
    }
    throw error;
  }

  return privateJson(
    {
      id,
      url: `${new URL(request.url).origin}/${id}`,
      filename,
      size: stored.size,
    },
    201,
  );
}
