import { createFileRoute } from "@tanstack/react-router";
import { optionsResponse, withCors } from "@/lib/api.server";
import { publicCacheHeaders } from "@/lib/media-response.server";
import { parseTranscript, transcriptToVtt } from "@/lib/transcript";
import { getUploadById } from "@/lib/uploads.server";
import {
  R2BudgetExceededError,
  R2BudgetUnavailableError,
  guardedR2Get,
} from "@/lib/r2-budget.server";

function headResponse(response: Response, head: boolean): Response {
  if (!head) return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function serveCaptions(id: string, head: boolean): Promise<Response> {
  const finish = (response: Response) => headResponse(withCors(response), head);
  const upload = await getUploadById(id);
  if (!upload?.transcriptKey)
    return finish(new Response("Not found", { status: 404 }));

  let object: R2ObjectBody | null;
  try {
    object = await guardedR2Get(upload.transcriptKey);
  } catch (error) {
    if (error instanceof R2BudgetExceededError)
      return finish(
        new Response("R2 read unavailable", {
          status: 429,
          headers: { "retry-after": String(error.retryAfter) },
        }),
      );
    if (error instanceof R2BudgetUnavailableError)
      return finish(new Response("R2 read unavailable", { status: 503 }));
    throw error;
  }
  if (!object) return finish(new Response("Not found", { status: 404 }));

  const transcript = parseTranscript(await object.json());
  if (!transcript) return finish(new Response("Not found", { status: 404 }));

  const headers = new Headers({ "content-type": "text/vtt; charset=utf-8" });
  publicCacheHeaders(headers);
  return finish(new Response(transcriptToVtt(transcript), { headers }));
}

/** WebVTT captions generated from the stored transcript sidecar. */
export const Route = createFileRoute("/api/captions/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => serveCaptions(params.id, false),
      HEAD: async ({ params }) => serveCaptions(params.id, true),
      OPTIONS: () => optionsResponse(),
    },
  },
});
