import { createFileRoute } from "@tanstack/react-router";
import { optionsResponse, withCors } from "@/lib/api.server";
import { publicCacheHeaders } from "@/lib/media-response.server";
import { parseStoryboardMeta, storyboardToVtt } from "@/lib/storyboard";
import { getUploadById } from "@/lib/uploads.server";

function headResponse(response: Response, head: boolean): Response {
  if (!head) return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function serveStoryboardVtt(
  id: string,
  origin: string,
  head: boolean,
): Promise<Response> {
  const finish = (response: Response) => headResponse(withCors(response), head);
  const upload = await getUploadById(id);
  if (!upload?.storyboardKey || !upload.storyboardMeta)
    return finish(new Response("Not found", { status: 404 }));

  let meta = null;
  try {
    meta = parseStoryboardMeta(JSON.parse(upload.storyboardMeta));
  } catch {
    meta = null;
  }
  if (!meta) return finish(new Response("Not found", { status: 404 }));

  const spriteUrl = `${origin}/api/storyboard/${upload.id}`;
  const headers = new Headers({ "content-type": "text/vtt; charset=utf-8" });
  publicCacheHeaders(headers);
  return finish(
    new Response(storyboardToVtt(meta, spriteUrl, upload.duration), {
      headers,
    }),
  );
}

/**
 * Thumbnails WebVTT for the player's scrub preview, generated from the
 * stored grid metadata so the sprite URL always matches this origin.
 */
export const Route = createFileRoute("/api/storyboard-vtt/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }) =>
        serveStoryboardVtt(params.id, new URL(request.url).origin, false),
      HEAD: async ({ params, request }) =>
        serveStoryboardVtt(params.id, new URL(request.url).origin, true),
      OPTIONS: () => optionsResponse(),
    },
  },
});
