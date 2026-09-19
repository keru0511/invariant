# MCP authentication with Cloudflare Access

`/mcp` authenticates executable MCP requests with a Cloudflare Access JWT.
The Worker reads the `Cf-Access-Jwt-Assertion` header, verifies the RS256
signature against the configured Access JWKS, and then checks `iss`, `aud`,
`exp`, `nbf`, and `sub`. Caller-provided email or workspace headers are not
used.

## Worker variables

Set these variables in the Worker environment. Values are configuration, not
secrets; the signing keys are fetched from the Access JWKS endpoint.

| Variable | Production value |
| --- | --- |
| `INVARIANT_ENVIRONMENT` | `production` |
| `MCP_AUTH_MODE` | `cloudflare-access` |
| `CLOUDFLARE_ACCESS_ISSUER` | `https://<team-name>.cloudflareaccess.com` |
| `CLOUDFLARE_ACCESS_AUDIENCE` | The Access application's AUD tag |
| `CLOUDFLARE_ACCESS_JWKS_URL` | Optional; defaults to `${CLOUDFLARE_ACCESS_ISSUER}/cdn-cgi/access/certs` |

The default mode is `cloudflare-access`, and missing production configuration
fails closed. `CLOUDFLARE_ACCESS_ISSUER` must be an HTTPS Access team issuer;
the verifier does not accept a caller-selected issuer or token algorithm.

## Test seam

Unit tests use an in-memory JWKS provider and a key pair generated during the
test run. They do not call Cloudflare or store a private key in the repository.
The `AccessTokenVerifier` and `AccessJwksProvider` interfaces are the provider
boundary for additional local fixtures.

The existing local MCP tests use the explicit pair below:

```ts
{
  INVARIANT_ENVIRONMENT: 'test',
  MCP_AUTH_MODE: 'test-bypass',
}
```

The bypass is accepted only when `INVARIANT_ENVIRONMENT` is exactly `test`.
Production mode rejects it, and an injected verifier is also ignored outside a
test environment. `OPTIONS /mcp` remains an unauthenticated CORS preflight;
MCP execution requests are always authenticated before the SDK handler runs.

## Account-side setup

The Cloudflare dashboard work is intentionally separate from this code PR:

1. Create an Access self-hosted application for the deployed `/mcp` hostname.
2. Add the intended identity policy and keep the application audience tag.
3. Configure the four production variables above in the Worker environment.
4. Verify a real Access-issued request reaches `domain.ping` after deployment.

No dashboard application, policy, real Access token, or production deployment
was available to this code change. Those account-side steps and live-token
verification remain unexecuted; they do not block the provider-boundary and
network-free code tests in this PR.
