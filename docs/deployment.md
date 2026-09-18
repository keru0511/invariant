# Production deployment and merge gate

Issue #22 keeps pull-request validation and production deployment separate. GitHub Actions runs the read-only `CI / quality` check; Cloudflare Workers Builds owns the production deploy from `main`. No deployment workflow or production secret belongs in this repository.

## Committed deployment contract

| Setting | Value |
| --- | --- |
| Repository | `keru0511/Invariant` |
| Worker name | `invariant` (must match `wrangler.jsonc`) |
| Workers Builds root directory | `/` |
| Production branch | `main` |
| Build command | `npm ci && npm run typecheck && npm test` |
| Production deploy command | `npx wrangler deploy` |
| Non-production branch builds | Disabled by default; if enabled, use `npx wrangler versions upload` for previews |
| Node version | `24.19.0` from `.node-version` (the optional non-secret `NODE_VERSION` setting may pin the same value) |
| Secrets in this repository | None; Cloudflare's connected-build authorization remains account-side |

The commands use the pinned Wrangler version from `package.json`. The committed `wrangler.jsonc` is the non-secret Worker configuration; the production branch and build settings are Workers Builds dashboard settings.

## GitHub required check on `main`

In the repository settings, create or edit the ruleset/branch protection rule targeting `main`:

1. Require a pull request before merging.
2. Under required status checks, add the exact check `CI / quality` (workflow `CI`, job `quality`). Do not select an unrelated check with a similar name.
3. Keep the rule enabled for the protected `main` branch. Ordinary pushes are not a substitute for the pull-request check.

The existing `.github/workflows/ci.yml` has read-only `contents` permission, a ten-minute job timeout, and no Cloudflare credentials or deploy command. Do not add `wrangler deploy` to GitHub Actions.

## Cloudflare Workers Builds setup

In Cloudflare Dashboard, open Workers & Pages and connect the `keru0511/Invariant` repository to the Worker named `invariant` under Settings → Build/Builds. Configure:

1. Root directory `/`.
2. Production branch `main` under Branch control.
3. Build command `npm ci && npm run typecheck && npm test`.
4. Production deploy command `npx wrangler deploy`.
5. Leave non-production branch builds disabled for this cost-controlled setup. If previews are later enabled, set their deploy command to `npx wrangler versions upload`.
6. If the dashboard asks for a Node setting, set the non-secret `NODE_VERSION` to `24.19.0`; `.node-version` already records the same pin.

Save the settings and let Workers Builds perform the deployment when a commit reaches `main`. Do not copy a Cloudflare token, account identifier, deploy hook URL, or other credential into the repository or GitHub Actions. Use the Cloudflare account UI for the connected-build authorization.

Cloudflare's current references: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), and [production branch control](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/).

## Local commands and smoke

Run the deterministic local checks first:

```bash
npm ci
npm run typecheck
npm test
```

For an explicitly authorized local deployment, use `npx wrangler deploy`. After a deployed URL is available, run:

```bash
npm run smoke:deployment -- <deployment-url>
```

The smoke makes `GET /health` and a JSON `POST /mcp` call to `tools/call` for `domain.ping`. It exits `0` only when both return the committed contracts; a missing URL exits `2`, and an HTTP, JSON, or MCP mismatch exits `1`. It never creates or reads a secret.

## Verification status for this setup PR

The deterministic tests cover the committed runbook/config and the smoke request/response contract. Account-side actions are not represented as passing tests:

- GitHub `main` ruleset requiring `CI / quality`: **NOT RUN** — requires repository settings access.
- Cloudflare repository connection and Workers Builds settings: **NOT RUN** — requires a Cloudflare account.
- Production build/deploy from `main`: **NOT RUN** — no account-side deployment was requested or authorized here.
- Live `/health` and MCP `domain.ping` smoke: **NOT RUN** — no deployed production URL was supplied.

These items must be recorded with their actual dashboard/build/smoke output after account access is available; absence of that access is not a PASS.
