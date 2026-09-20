import serverEntry from "@tanstack/react-start/server-entry"
import { handleMcp } from "@/mcp.server"

type StartServerFetch = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname === "/mcp")
      return handleMcp(request, env, ctx)
    const appFetch = serverEntry.fetch as StartServerFetch
    return appFetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
