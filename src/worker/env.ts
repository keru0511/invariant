/**
 * Cloudflare Worker bindings used by the HTTP/MCP boundary.
 *
 * `INVARIANT_ENVIRONMENT` is intentionally separate from `MCP_AUTH_MODE`.
 * A test bypass is accepted only when both values explicitly identify a test
 * runtime; the production default is always Cloudflare Access verification.
 */
export interface Env {
  /** Defaults to `production` when omitted. */
  readonly INVARIANT_ENVIRONMENT?: 'production' | 'test';

  /** Defaults to `cloudflare-access` when omitted. */
  readonly MCP_AUTH_MODE?: 'cloudflare-access' | 'test-bypass';

  /** Exact Cloudflare Access issuer, for example https://team.cloudflareaccess.com. */
  readonly CLOUDFLARE_ACCESS_ISSUER?: string;

  /** Application Audience (AUD) tag assigned to the Access application. */
  readonly CLOUDFLARE_ACCESS_AUDIENCE?: string;

  /** Optional override; otherwise `${CLOUDFLARE_ACCESS_ISSUER}/cdn-cgi/access/certs`. */
  readonly CLOUDFLARE_ACCESS_JWKS_URL?: string;
}
