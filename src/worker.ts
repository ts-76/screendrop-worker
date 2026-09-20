import serverEntry from "@tanstack/react-start/server-entry"
import { handleMcp } from "@/mcp.server"

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: {
        env: Env
        ctx: ExecutionContext
      }
    }
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname === "/mcp")
      return handleMcp(request, env, ctx)
    return serverEntry.fetch(request, { context: { env, ctx } })
  },
} satisfies ExportedHandler<Env>
