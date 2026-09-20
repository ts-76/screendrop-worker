# Screendrop Worker

The cloud backend for [Screendrop](https://github.com/fayazara/screendrop), an open-source native macOS screenshot and screen recording tool. This worker handles uploading, storing, and sharing captures — screenshots get a clean viewer, and recordings get a full Loom-style share page.

Built with [TanStack Start](https://tanstack.com/start/latest) on [Cloudflare Workers](https://developers.cloudflare.com/workers/), with [Kumo](https://kumo-ui.com/) for the UI, [Video.js v10](https://videojs.org/) for the player, [R2](https://developers.cloudflare.com/r2/) for file storage, and [D1](https://developers.cloudflare.com/d1/) for metadata.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ts-76/screendrop-worker)

## How it works

1. The Screendrop macOS app captures a screenshot or screen recording
2. The file is uploaded to this worker (either via multipart form or streaming upload)
3. For recordings, the app then sends sidecar assets in the background: a poster frame, a title, the on-device transcript, and a scrub-preview sprite sheet
4. The worker stores files in R2 and metadata in D1
5. A shareable link is returned (e.g. `https://your-worker.workers.dev/a1b2c3d4`)

Anyone with a recording link sees a share page with:

- A video player with hover scrub previews, captions, playback speed, picture-in-picture, and theater mode
- A live transcript panel — the active line follows playback, clicking a line seeks, search filters with highlighting
- Comments, optionally pinned to a timestamp, and likes — both require signing in with GitHub or Google (see [Comment sign-in](#comment-sign-in-required-oauth) below); an upload can also turn both off entirely
- View counts, and OG tags so links unfurl with a poster image in chat apps

Screenshots keep a lightweight viewer page with download, copy link, and copy image actions, plus the same comments and likes as recordings. The transcript is rendered server-side, so share pages arrive readable and indexable.

Each upload picks its own title and whether comments/likes are enabled at upload time (the Screendrop app prompts for this before sharing); both default to on if the client doesn't specify.

## Deploy

The smoothest path is to start from the Screendrop app:

1. Open **Screendrop → Settings → Cloud**. The app generates a secure `UPLOAD_TOKEN` for you — copy it.
2. Click **Deploy to Cloudflare** (the button above, also available in the app). The deploy flow will:
   - Clone this repo into your GitHub account
   - Automatically provision an R2 bucket and D1 database
   - Prompt you for the `UPLOAD_TOKEN` secret — **paste the token you copied from the app**
   - Deploy the worker and set up CI/CD via Workers Builds
3. Back in the app, paste your worker URL (the token is already filled in) and click **Verify Connection**.

**Database schema:** the worker provisions its own D1 schema at runtime (it is created
idempotently on `/api/setup` and self-heals on the first upload), so there is no manual
migration step after a one-click deploy. `Verify Connection` calls `/api/setup` for you.

### Cloudflare hardening settings

The worker keeps public share/media reads cacheable for a short, configurable period,
while protected mutations and application pages remain private. The default
`wrangler.jsonc` values are deliberately conservative:

| Setting                  | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `R2_DAILY_READ_LIMIT`    | Maximum R2 reads reserved by the global Durable Object per UTC day   |
| `R2_MONTHLY_READ_LIMIT`  | Maximum R2 reads reserved per UTC month                              |
| `CACHE_TTL_SECONDS`      | Shared Cache API TTL for validated public media                      |
| `RATE_LIMIT`             | Cloudflare Worker Rate Limiting binding for public GET/HEAD requests |
| `RATE_LIMIT_RETRY_AFTER` | Retry-After value for the public request limiter                     |
| `R2_BUDGET_RETRY_AFTER`  | Retry-After value when the R2 budget is exhausted                    |

The `R2Budget` Durable Object migration is declared in `wrangler.jsonc` and is applied
by `wrangler deploy` (migration tag `r2-budget-v1`). It fails closed when its limits
are missing or invalid. Set `UPLOAD_TOKEN` as a secret with
`wrangler secret put UPLOAD_TOKEN`; do not put tokens or account-specific IDs in the
repository. The worker also runs on a `workers.dev` URL without requiring a custom
domain.

The Wrangler Workers Caching section is intentionally disabled. Public media uses only
the Worker-internal Cache API, so every request still reaches the Worker boundary for
bot filtering, IP rate limiting, D1 deletion checks, and the R2 budget guard. Public
media responses use `Cache-Control: public, max-age=0, s-maxage=<TTL>,
must-revalidate`: browsers revalidate on every request while the Worker Cache API can
reuse the body for the configured shared TTL. Do not add a Workers-level cache rule
in front of this Worker unless it preserves those controls.

Cache API storage is best-effort. Cloudflare documents functional Cache API operations
for custom-domain Workers; on `workers.dev`, Access-fronted deployments, or local
preview they may be unavailable. The Worker still serves the request safely in those
cases, with the R2 budget guard applying to the fallback read.

Do not enable an R2 public development URL or an R2 custom domain for the bucket used
by this worker. Those direct URLs bypass the Worker’s authentication, bot controls,
rate limit, cache policy, and R2 budget guard. Use the Worker URL for every share and
media link. The User-Agent bot deny list is only a supplemental signal; it is not a
replacement for Cloudflare WAF/Bot Management and edge rate-limiting rules.

## Updating your worker

When you deploy with the button, Cloudflare **clones** this repo into your own
GitHub account and connects it to Workers Builds. Your copy is independent — it
does not auto-update when this upstream repo changes. The Screendrop app checks
the deployed worker's version (via `/api/version`) and shows a non-blocking
notice when an update is available.

Deploy-button clones may not share commit history with this repository. The
first update therefore needs to connect the two histories while replacing the
application files with the current upstream version. Later updates are normal
Git merges.

### First update of a deploy-button clone

Before starting, open the clone's existing `wrangler.json` and save these
deployment-specific values:

- The Worker `name`
- The D1 `database_id` and `database_name`
- The R2 `bucket_name` and `preview_bucket_name`, if present

These values point at your existing Worker, database, and bucket. Do not replace
them with the blank auto-provisioning bindings from this template.

In a local checkout of your clone:

```bash
git switch main
git pull --ff-only
git switch -c update-from-upstream

# Add the template as an upstream remote. This is needed only once per checkout.
git remote add upstream https://github.com/fayazara/screendrop-worker.git
git fetch upstream

# Connect the independent histories, then use the upstream application tree.
git merge --allow-unrelated-histories --strategy=ours --no-commit upstream/main
git restore --source=upstream/main --staged --worktree .
```

The upstream tree uses `wrangler.jsonc`. Update it with the resource values you
saved above:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "<YOUR_EXISTING_WORKER_NAME>",
  "main": "@tanstack/react-start/server-entry",
  "compatibility_date": "2026-07-17",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true,
  },
  "upload_source_maps": true,
  "d1_databases": [
    {
      "binding": "DB",
      "database_id": "<YOUR_EXISTING_DATABASE_ID>",
      "database_name": "<YOUR_EXISTING_DATABASE_NAME>",
      "migrations_dir": "drizzle",
    },
  ],
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": "<YOUR_EXISTING_BUCKET_NAME>",
      "preview_bucket_name": "<YOUR_EXISTING_PREVIEW_BUCKET_NAME>",
    },
  ],
}
```

Validate, commit, and deploy the update:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run build

git add -A
git commit -m "Sync with Screendrop Worker upstream"
git switch main
git merge --ff-only update-from-upstream
git push origin main
```

The merge commit permanently connects the histories. A push to `main` triggers
Workers Builds and updates the existing Worker because its name and bindings
were preserved.

### Future updates

After the first update, syncing is much simpler:

```bash
git switch main
git pull --ff-only
git fetch upstream
git merge upstream/main

# If wrangler.jsonc conflicts, keep your existing Worker and resource values.
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
git push origin main
```

Notes:

- Your secrets (`UPLOAD_TOKEN`, `AUTHOR_NAME`, `AUTHOR_AVATAR`) live in
  Cloudflare, not in the repository, so syncing does not replace them.
- Do not run `db:migrate:remote` when updating an existing deployment. After
  the redeploy, click **Verify Connection** in Screendrop; `/api/setup` safely
  upgrades the existing schema without deleting uploads.
- If you maintain custom code in your clone, perform the update on a branch and
  review the diff before merging it into `main`.

### Manual setup

If you prefer to deploy manually:

```bash
git clone https://github.com/fayazara/screendrop-worker.git
cd screendrop-worker
pnpm install

# Set your upload token as a secret
wrangler secret put UPLOAD_TOKEN

# Deploy (auto-provisions R2 + D1; the schema self-provisions at runtime)
pnpm run deploy
```

## API

All API routes are CORS-enabled. Routes marked with a lock require a Bearer token (`UPLOAD_TOKEN`).

| Method   | Route                          | Auth   | Description                                                          |
| -------- | ------------------------------ | ------ | -------------------------------------------------------------------- |
| `GET`    | `/api/version`                 | Public | Returns the deployed worker version                                  |
| `POST`   | `/api/setup`                   | Bearer | Idempotently provision the D1 schema                                 |
| `GET`    | `/api/ping`                    | Bearer | Connection health check (returns `version`)                          |
| `POST`   | `/api/upload`                  | Bearer | Multipart file upload                                                |
| `PUT`    | `/api/upload`                  | Bearer | Streaming upload (raw bytes, metadata via headers)                   |
| `POST`   | `/api/register`                | Bearer | Register metadata for a file already uploaded to R2                  |
| `POST`   | `/api/assets/:id`              | Bearer | Attach sidecars to an upload: poster, transcript, storyboard, title  |
| `DELETE` | `/api/upload/:id`              | Bearer | Delete an upload permanently: R2 files, comments, likes, view events |
| `GET`    | `/api/media/:id`               | Public | Serve raw file from R2 (Range requests supported)                    |
| `GET`    | `/api/image/:id`               | Public | Serve a screenshot from R2                                           |
| `GET`    | `/api/poster/:id`              | Public | Poster frame for a recording                                         |
| `GET`    | `/api/captions/:id`            | Public | Captions as WebVTT, generated from the stored transcript             |
| `GET`    | `/api/storyboard/:id`          | Public | Scrub-preview sprite sheet                                           |
| `GET`    | `/api/storyboard-vtt/:id`      | Public | Thumbnails WebVTT pointing at sprite tiles                           |
| `GET`    | `/api/comments/:id`            | Public | List comments for an upload (403 if the upload has comments off)     |
| `POST`   | `/api/comments/:id`            | Public | Post a comment — requires a signed-in session (401 otherwise)        |
| `PATCH`  | `/api/comments/:id`            | Public | Edit a comment (author only, signed in)                              |
| `DELETE` | `/api/comments/:id`            | Public | Delete a comment (author only, signed in)                            |
| `GET`    | `/api/likes/:id`               | Public | Like count, and whether the signed-in viewer already liked           |
| `POST`   | `/api/likes/:id`               | Public | Like an upload — requires a signed-in session (401 otherwise)        |
| `DELETE` | `/api/likes/:id`               | Public | Unlike an upload (signed in)                                         |
| `GET`    | `/api/auth/me`                 | Public | Session probe: configured providers + signed-in user                 |
| `GET`    | `/api/auth/login`              | Public | Start OAuth sign-in (`?provider=github\|google&redirect=/:id`)       |
| `GET`    | `/api/auth/callback/:provider` | Public | OAuth callback (register this URL on your OAuth app)                 |
| `POST`   | `/api/auth/logout`             | Public | Clear the session cookie                                             |
| `POST`   | `/api/view/:id`                | Public | Increment the view counter (client-deduplicated)                     |
| `GET`    | `/:id`                         | Public | Share page (recordings) or viewer page (screenshots) with OG tags    |

### Upload (multipart)

```bash
curl -X POST https://your-worker.workers.dev/api/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@screenshot.png" \
  -F "width=1920" \
  -F "height=1080" \
  -F "title=Onboarding walkthrough" \
  -F "social_enabled=false"
```

`title` and `social_enabled` are both optional. `social_enabled` defaults to `true`; pass `false` (or `0`) to turn off comments and likes for this upload.

### Upload (streaming)

For large files. The request body is the raw file — no buffering in Worker memory.

```bash
curl -X PUT https://your-worker.workers.dev/api/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: image/png" \
  -H "X-Filename: screenshot.png" \
  -H "X-Width: 1920" \
  -H "X-Height: 1080" \
  -H "X-Title: Onboarding walkthrough" \
  -H "X-Social-Enabled: false" \
  --data-binary @screenshot.png
```

`X-Title` and `X-Social-Enabled` are both optional, with the same defaults as the multipart form above.

### Response

```json
{
  "id": "a1b2c3d4",
  "url": "https://your-worker.workers.dev/a1b2c3d4",
  "filename": "screenshot.png",
  "size": 204800
}
```

### Sidecar assets

After a video upload, the Screendrop app enriches the share page with a second, best-effort request. Every part is optional — the page works without them and upgrades as they land.

```bash
curl -X POST https://your-worker.workers.dev/api/assets/a1b2c3d4 \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "poster=@poster.jpg;type=image/jpeg" \
  -F "title=Onboarding walkthrough" \
  -F "transcript=@transcript.json" \
  -F "storyboard=@storyboard.jpg;type=image/jpeg" \
  -F 'storyboard_meta={"tileWidth":160,"tileHeight":104,"columns":6,"interval":2,"count":37}'
```

- `transcript` is JSON: `{ "cues": [{ "start", "end", "text" }], "words": [{ "text", "start", "end" }] }`. Cues drive the captions and transcript panel; word timings are optional.
- `storyboard` is a sprite-sheet JPEG; `storyboard_meta` describes its grid. The worker generates the thumbnails WebVTT from it at request time.

## Configuration

### Secrets

`UPLOAD_TOKEN`, `AUTHOR_NAME`, and `AUTHOR_AVATAR` are prompted during the Deploy to Cloudflare flow (defined in `.dev.vars.example`). OAuth credentials are intentionally configured after deployment with `wrangler secret put`, because Cloudflare's deploy form treats listed fields as required even when their descriptions say “Optional”:

| Secret                                      | Description                                                                  | Required |
| ------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| `UPLOAD_TOKEN`                              | Shared token for authenticating uploads (generated by the Screendrop app)    | Yes      |
| `AUTHOR_NAME`                               | Display name shown on shared pages (falls back to `Anonymous`)               | No       |
| `AUTHOR_AVATAR`                             | Avatar URL shown on shared pages (falls back to a generated avatar)          | No       |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app credentials — enables "Sign in with GitHub" for comments    | No       |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client credentials — enables "Sign in with Google" for comments | No       |
| `AUTH_SECRET`                               | Overrides the session-cookie signing key (defaults to `UPLOAD_TOKEN`)        | No       |

### Read-only MCP endpoint

The Worker also exposes a stateless, read-only MCP endpoint at `/mcp`. It is
served by the same Worker as the public sharing and upload routes, so both the
`workers.dev` URL and a configured Custom Domain can be used. Only the exact
`/mcp` path is handled by MCP; all other paths keep their normal application
behavior.

Protect only the `/mcp` path with a Cloudflare Access self-hosted application
and enable Managed OAuth. Configure the Access application as
`https://<your-worker>/mcp` (or the equivalent `workers.dev/mcp` path), not as
the whole hostname. Do not put the public share pages, media routes, or upload
API behind this Access application. The Worker validates the
`Cf-Access-Jwt-Assertion` signature,
issuer, audience, expiry, and subject before it invokes any MCP handler. The
Access values are deployment configuration, not source-code constants:

| Variable | Description | Required |
| -------- | ----------- | -------- |
| `MCP_ACCESS_TEAM_DOMAIN` | Issuer URL, for example `https://<your-team>.cloudflareaccess.com` | Yes |
| `MCP_ACCESS_AUDIENCE` | Access application AUD tag for the MCP application | Yes |
| `MCP_ACCESS_ISSUER` | Optional explicit issuer override; otherwise the team domain is used | No |
| `MCP_ACCESS_JWKS_URL` | Optional explicit Access certs URL; otherwise `<issuer>/cdn-cgi/access/certs` is used | No |

Set the variables in your deployment environment, Cloudflare dashboard, or
local `.dev.vars`; they are intentionally not listed as empty `vars` entries
in `wrangler.jsonc`, so an empty config value cannot overwrite a real setting.
Do not commit real tenant identifiers or tokens. This project sets
`keep_vars: true`, so a deploy does not erase values already configured in the
dashboard. The configured
`MCP_RATE_LIMIT` binding applies a per-subject limit before tool execution.

The available tools are read-only:

- `search_captures` — bounded metadata search with pagination
- `get_capture` — metadata and available sidecars
- `get_image` — bounded original or poster image content
- `get_transcript` — transcript JSON sidecar
- `get_download_link` — public media URL for an existing capture

The endpoint does not expose upload, delete, comment, like, or settings
operations. After configuring Access, connect an MCP client to
`https://<your-worker>/mcp` (or the equivalent `workers.dev` URL).

### Comment sign-in (required OAuth)

Comments and likes always require a signed-in viewer — there is no anonymous/guest path. Configure GitHub and/or Google OAuth to turn the features on; without at least one provider configured, the comment box and like button simply don't appear on share pages, since there'd be no way to sign in. Comments carry the signed-in account's name and avatar.

There is no central auth service: you register your own OAuth app, and viewers sign in against your deployment only. Sessions are stateless HMAC-signed cookies — no extra tables, nothing to manage.

Deploy first, then create the OAuth app (the callback URL needs your worker's URL):

**GitHub** (~2 minutes): [github.com/settings/developers](https://github.com/settings/developers) → New OAuth App → set the authorization callback URL to `https://<your-worker>/api/auth/callback/github`. Only the public profile (id, username, avatar) is requested.

**Google**: [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) → Create OAuth client ID (Web application) → add `https://<your-worker>/api/auth/callback/google` as an authorized redirect URI. You'll need to configure the consent screen first; only the `openid profile` scope is requested, so no verification is required. Publish the consent screen (Audience → In production), otherwise only test users can sign in.

Then set the secrets:

```bash
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

Configure one provider or both — only configured providers show up as sign-in buttons. Removing both secrets turns off comments and likes entirely (no anonymous fallback).

### Bindings (auto-provisioned)

| Type | Binding  | Purpose                                     |
| ---- | -------- | ------------------------------------------- |
| R2   | `BUCKET` | File storage for screenshots and recordings |
| D1   | `DB`     | SQLite database for upload metadata         |

## Development

```bash
pnpm install
pnpm run dev
```

This starts a local dev server at `http://localhost:3000` with hot reload. Local R2 and D1 resources are created automatically and persist between runs.

### Database migrations

```bash
# Apply migrations locally
pnpm run db:migrate:local

# Apply migrations to production
pnpm run db:migrate:remote
```

## License

MIT
