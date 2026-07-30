import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { comments, likes, uploads, viewEvents } from "@/db/schema"
import { json, optionsResponse, protectedApi } from "@/lib/api.server"
import { ensureSchema, getUploadById } from "@/lib/uploads.server"

/**
 * Deletes an upload entirely: the main file and any sidecars (poster,
 * transcript, storyboard) from R2, plus the upload's own row and its
 * comments/likes/view-event rows from D1. Irreversible — the share link
 * 404s immediately after.
 */
export const Route = createFileRoute("/api/upload/$id")({
  server: {
    handlers: {
      DELETE: async ({ params, request }) =>
        protectedApi(request, env.UPLOAD_TOKEN, async () => {
          await ensureSchema()

          const upload = await getUploadById(params.id)
          if (!upload) {
            return json({ error: "Upload not found" }, 404)
          }

          const keys = [
            upload.r2Key,
            upload.posterKey,
            upload.transcriptKey,
            upload.storyboardKey,
          ].filter((key): key is string => Boolean(key))
          if (keys.length > 0) {
            await env.BUCKET.delete(keys)
          }

          await db.delete(comments).where(eq(comments.uploadId, upload.id))
          await db.delete(likes).where(eq(likes.uploadId, upload.id))
          await db
            .delete(viewEvents)
            .where(eq(viewEvents.uploadId, upload.id))
          await db.delete(uploads).where(eq(uploads.id, upload.id))

          return json({ deleted: true })
        }),

      OPTIONS: () => optionsResponse(),
    },
  },
})
