import { createRemoteJWKSet, jwtVerify } from "jose"
import type { JWTPayload } from "jose"

export type McpIdentity = {
  subject: string
  issuer: string
  audience: string
  expiresAt: number
  email?: string
}

type AccessConfig = {
  issuer: string
  audience: string
  jwksUrl: string
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function configured(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function configuredEnv(env: Env, name: string): string | undefined {
  const value = Reflect.get(env, name)
  return typeof value === "string" ? value : undefined
}

export function getMcpAccessConfig(env: Env): AccessConfig | null {
  const explicitIssuer = configuredEnv(env, "MCP_ACCESS_ISSUER")
  const teamDomain = configuredEnv(env, "MCP_ACCESS_TEAM_DOMAIN")
  const explicitJwksUrl = configuredEnv(env, "MCP_ACCESS_JWKS_URL")
  const audienceValue = configuredEnv(env, "MCP_ACCESS_AUDIENCE")
  const issuer = configured(explicitIssuer)
    ? trimTrailingSlash(explicitIssuer)
    : configured(teamDomain)
      ? trimTrailingSlash(teamDomain)
      : ""
  const audience = configured(audienceValue) ? audienceValue.trim() : ""
  const jwksUrl = configured(explicitJwksUrl)
    ? explicitJwksUrl.trim()
    : issuer
      ? `${issuer}/cdn-cgi/access/certs`
      : ""

  if (!issuer || !audience || !jwksUrl) return null
  try {
    new URL(issuer)
    new URL(jwksUrl)
  } catch {
    return null
  }
  return { issuer, audience, jwksUrl }
}

function getJwks(url: string) {
  const cached = jwksCache.get(url)
  if (cached) return cached
  const jwks = createRemoteJWKSet(new URL(url))
  jwksCache.set(url, jwks)
  return jwks
}

function subject(payload: JWTPayload): string | null {
  return typeof payload.sub === "string" && payload.sub.trim().length > 0
    ? payload.sub
    : null
}

export async function verifyMcpAccessAssertion(
  assertion: string | null,
  env: Env,
): Promise<McpIdentity | null> {
  if (!assertion) return null
  const config = getMcpAccessConfig(env)
  if (!config) return null
  try {
    const { payload } = await jwtVerify(assertion, getJwks(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
    })
    const sub = subject(payload)
    if (!sub || typeof payload.exp !== "number") return null
    return {
      subject: sub,
      issuer: config.issuer,
      audience: config.audience,
      expiresAt: payload.exp,
      ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    }
  } catch {
    return null
  }
}
