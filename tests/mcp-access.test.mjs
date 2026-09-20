import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const { build } = require(
  require.resolve("esbuild", { paths: [require.resolve("wrangler")] }),
)
const { exportJWK, generateKeyPair, SignJWT } = await import("jose")

async function loadAccessModule() {
  const bundle = await build({
    entryPoints: ["src/lib/mcp-access.server.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`,
  )
}

test("Cloudflare Access JWT verification is issuer/audience/subject bound", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const jwk = await exportJWK(publicKey)
  jwk.kid = "review-key"
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
    })
  try {
    const { verifyMcpAccessAssertion } = await loadAccessModule()
    const env = {
      MCP_ACCESS_TEAM_DOMAIN: "https://team.example.cloudflareaccess.com",
      MCP_ACCESS_ISSUER: "",
      MCP_ACCESS_JWKS_URL: "https://team.example.test/certs",
      MCP_ACCESS_AUDIENCE: "mcp-audience",
    }
    const token = await new SignJWT({ email: "owner@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "review-key" })
      .setIssuer(env.MCP_ACCESS_TEAM_DOMAIN)
      .setAudience(env.MCP_ACCESS_AUDIENCE)
      .setSubject("owner-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)

    const identity = await verifyMcpAccessAssertion(token, env)
    assert.equal(identity?.subject, "owner-subject")
    assert.equal(identity?.issuer, env.MCP_ACCESS_TEAM_DOMAIN)
    assert.equal(identity?.audience, env.MCP_ACCESS_AUDIENCE)
    assert.equal(identity?.email, "owner@example.com")
    assert.equal(typeof identity?.expiresAt, "number")
    assert.equal(
      await verifyMcpAccessAssertion(
        await new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "review-key" })
          .setIssuer(env.MCP_ACCESS_TEAM_DOMAIN)
          .setAudience("wrong-audience")
          .setSubject("owner-subject")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey),
        env,
      ),
      null,
    )
    assert.equal(await verifyMcpAccessAssertion(null, env), null)
  } finally {
    globalThis.fetch = oldFetch
  }
})
