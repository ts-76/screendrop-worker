import { createFileRoute } from "@tanstack/react-router";
import { optionsResponse } from "@/lib/api.server";
import { serveAsset } from "@/lib/media-response.server";
import { getUploadById } from "@/lib/uploads.server";

export const Route = createFileRoute("/api/poster/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const upload = await getUploadById(params.id);
        return serveAsset(upload?.posterKey ?? null, "image/jpeg", request);
      },
      HEAD: async ({ params, request }) => {
        const upload = await getUploadById(params.id);
        return serveAsset(upload?.posterKey ?? null, "image/jpeg", request);
      },
      OPTIONS: () => optionsResponse(),
    },
  },
});
