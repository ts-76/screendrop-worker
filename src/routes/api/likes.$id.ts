import { createFileRoute } from "@tanstack/react-router";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { likes } from "@/db/schema";
import { json, optionsResponse } from "@/lib/api.server";
import { getSessionUser } from "@/lib/auth.server";
import { ensureSchema, getUploadById } from "@/lib/uploads.server";

/**
 * Likes on a share, one per viewer. Same trust model as comments: the
 * session cookie is the only identity source, and the upload's
 * socialEnabled switch turns likes off along with comments.
 */
export const Route = createFileRoute("/api/likes/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        await ensureSchema();
        const user = await getSessionUser(request);
        const liked = user
          ? (await db.query.likes.findFirst({
              where: and(
                eq(likes.uploadId, params.id),
                eq(likes.viewerId, user.sub),
              ),
            })) !== undefined
          : false;
        return json({ count: await likeCount(params.id), liked });
      },

      POST: async ({ params, request }) => {
        await ensureSchema();
        const upload = await getUploadById(params.id);
        if (!upload) return json({ error: "Upload not found" }, 404);
        if (!upload.socialEnabled) {
          return json({ error: "Likes are turned off for this upload" }, 403);
        }

        const user = await getSessionUser(request);
        if (!user) return json({ error: "Sign in to like" }, 401);

        await db
          .insert(likes)
          .values({ uploadId: params.id, viewerId: user.sub })
          .onConflictDoNothing();
        return json({ count: await likeCount(params.id), liked: true });
      },

      DELETE: async ({ params, request }) => {
        await ensureSchema();
        const user = await getSessionUser(request);
        if (!user) return json({ error: "Sign in to like" }, 401);

        await db
          .delete(likes)
          .where(
            and(eq(likes.uploadId, params.id), eq(likes.viewerId, user.sub)),
          );
        return json({ count: await likeCount(params.id), liked: false });
      },

      OPTIONS: () => optionsResponse(),
    },
  },
});

async function likeCount(uploadId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(likes)
    .where(eq(likes.uploadId, uploadId));
  return row.total;
}
