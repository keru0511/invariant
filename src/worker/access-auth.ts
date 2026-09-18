import type { Env } from './env';

/** Header added by Cloudflare Access after the request passes its policy. */
export const CF_ACCESS_JWT_ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';

const ACCESS_JWT_ALGORITHM = 'RS256';
const MAX_ACCESS_JWT_LENGTH = 16 * 1024;

export interface AccessPrincipal {
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly email?: string;
}

/**
 * Provider boundary for verified Cloudflare Access identities.
 *
 * The MCP boundary depends on this interface rather than on JWKS transport or
 * JWT implementation details. Tests can inject this provider without network
 * access; production uses the Web Crypto/JWKS implementation below.
 */
export interface AccessTokenVerifier {
  verify(request: Request): Promise<AccessPrincipal>;
}

export interface AccessJwk extends JsonWebKey {
  readonly kid?: string;
}

export interface AccessJwkSet {
  readonly keys: readonly AccessJwk[];
}

export interface AccessJwksProvider {
  getJwks(): Promise<AccessJwkSet>;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface AccessVerifierDependencies {
  readonly fetch?: FetchLike;
  readonly jwksProvider?: AccessJwksProvider;
  readonly now?: () => number;
}

export interface CloudflareAccessVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl?: string;
}

class AccessVerificationError extends Error {
  constructor() {
    super('Cloudflare Access token verification failed');
    this.name = 'AccessVerificationError';
  }
}

class AccessConfigurationError extends Error {
  constructor() {
    super('Cloudflare Access verification is not configured');
    this.name = 'AccessConfigurationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AccessConfigurationError();
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AccessConfigurationError();
  }

  const normalized = url.toString().replace(/\/$/, '');
  if (normalized === 'https:' || normalized.length <= 'https://'.length) {
    throw new AccessConfigurationError();
  }

  return normalized;
}

function normalizeIssuer(value: string): string {
  const issuer = normalizeHttpsUrl(value);
  const parsed = new URL(issuer);
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new AccessConfigurationError();
  }
  return parsed.origin;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new AccessVerificationError();
  }

  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new AccessVerificationError();
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeJsonSegment(value: string): Record<string, unknown> {
  const bytes = decodeBase64Url(value);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) {
      throw new AccessVerificationError();
    }
    return parsed;
  } catch (error) {
    if (error instanceof AccessVerificationError) {
      throw error;
    }
    throw new AccessVerificationError();
  }
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AccessVerificationError();
  }
  return value;
}

function readNumericDate(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AccessVerificationError();
  }
  return value;
}

function hasExpectedAudience(value: unknown, expected: string): boolean {
  if (typeof value === 'string') {
    return value === expected;
  }
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string')
    && value.includes(expected);
}

function getDefaultJwksUrl(issuer: string): string {
  return new URL('/cdn-cgi/access/certs', issuer).toString();
}

function validateJwkForRs256(key: AccessJwk): void {
  if (
    key.kty !== 'RSA'
    || typeof key.n !== 'string'
    || typeof key.e !== 'string'
    || (key.alg !== undefined && key.alg !== ACCESS_JWT_ALGORITHM)
    || (key.use !== undefined && key.use !== 'sig')
  ) {
    throw new AccessVerificationError();
  }
}

function createPrincipal(
  claims: Record<string, unknown>,
  issuer: string,
  audience: string,
  now: number
): AccessPrincipal {
  const claimIssuer = readRequiredString(claims, 'iss');
  if (claimIssuer !== issuer || !hasExpectedAudience(claims.aud, audience)) {
    throw new AccessVerificationError();
  }

  const expiresAt = readNumericDate(claims, 'exp');
  if (expiresAt <= now) {
    throw new AccessVerificationError();
  }

  if (claims.nbf !== undefined) {
    const notBefore = readNumericDate(claims, 'nbf');
    if (notBefore > now) {
      throw new AccessVerificationError();
    }
  }

  if (claims.iat !== undefined) {
    readNumericDate(claims, 'iat');
  }

  const subject = readRequiredString(claims, 'sub');
  const email = typeof claims.email === 'string' && claims.email.length > 0
    ? claims.email
    : undefined;

  return {
    subject,
    issuer,
    audience,
    expiresAt,
    ...(email === undefined ? {} : { email }),
  };
}

export function createRemoteJwksProvider(
  jwksUrl: string,
  fetchImpl?: FetchLike
): AccessJwksProvider {
  const url = normalizeHttpsUrl(jwksUrl);
  const fetcher = fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async getJwks(): Promise<AccessJwkSet> {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new AccessVerificationError();
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AccessVerificationError();
      }
      if (!isRecord(body) || !Array.isArray(body.keys)) {
        throw new AccessVerificationError();
      }

      const keys = body.keys.filter((key): key is AccessJwk => isRecord(key)) as AccessJwk[];
      if (keys.length === 0) {
        throw new AccessVerificationError();
      }
      return { keys };
    },
  };
}

class CloudflareAccessJwtVerifier implements AccessTokenVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksProvider: AccessJwksProvider;
  private readonly now: () => number;

  constructor(
    config: CloudflareAccessVerifierConfig,
    dependencies: AccessVerifierDependencies = {}
  ) {
    this.issuer = normalizeIssuer(config.issuer);
    this.audience = config.audience.trim();
    if (this.audience.length === 0) {
      throw new AccessConfigurationError();
    }

    const jwksUrl = config.jwksUrl === undefined
      ? getDefaultJwksUrl(this.issuer)
      : config.jwksUrl;
    this.jwksProvider = dependencies.jwksProvider
      ?? createRemoteJwksProvider(jwksUrl, dependencies.fetch);
    this.now = dependencies.now ?? (() => Date.now() / 1000);
  }

  async verify(request: Request): Promise<AccessPrincipal> {
    const token = request.headers.get(CF_ACCESS_JWT_ASSERTION_HEADER);
    if (token === null || token.length === 0 || token.length > MAX_ACCESS_JWT_LENGTH) {
      throw new AccessVerificationError();
    }

    const segments = token.split('.');
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
      throw new AccessVerificationError();
    }

    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const header = decodeJsonSegment(encodedHeader);
    const payload = decodeJsonSegment(encodedPayload);
    const algorithm = readRequiredString(header, 'alg');
    const keyId = readRequiredString(header, 'kid');
    if (algorithm !== ACCESS_JWT_ALGORITHM) {
      throw new AccessVerificationError();
    }

    const jwks = await this.jwksProvider.getJwks();
    const jwk = jwks.keys.find((key) => key.kid === keyId);
    if (jwk === undefined) {
      throw new AccessVerificationError();
    }
    validateJwkForRs256(jwk);

    let publicKey: CryptoKey;
    try {
      publicKey = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
    } catch {
      throw new AccessVerificationError();
    }

    const signature = decodeBase64Url(encodedSignature);
    const validSignature = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      publicKey,
      signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
    if (!validSignature) {
      throw new AccessVerificationError();
    }

    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new AccessVerificationError();
    }
    return createPrincipal(payload, this.issuer, this.audience, now);
  }
}

export function createCloudflareAccessVerifier(
  config: CloudflareAccessVerifierConfig,
  dependencies: AccessVerifierDependencies = {}
): AccessTokenVerifier {
  return new CloudflareAccessJwtVerifier(config, dependencies);
}

function createTestBypassVerifier(): AccessTokenVerifier {
  return {
    async verify(): Promise<AccessPrincipal> {
      return {
        subject: 'test-bypass',
        issuer: 'test-only',
        audience: 'test-only',
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
    },
  };
}

/**
 * Resolve the only verifier that the Worker entry point may use.
 *
 * The bypass is deliberately guarded by an explicit test environment marker.
 * Missing or contradictory configuration throws, and the caller converts that
 * into an authentication failure rather than serving MCP traffic.
 */
export function createAccessTokenVerifier(
  env: Env,
  dependencies: AccessVerifierDependencies = {}
): AccessTokenVerifier {
  const mode = env.MCP_AUTH_MODE ?? 'cloudflare-access';
  if (mode === 'test-bypass') {
    if (env.INVARIANT_ENVIRONMENT !== 'test') {
      throw new AccessConfigurationError();
    }
    return createTestBypassVerifier();
  }

  if (mode !== 'cloudflare-access') {
    throw new AccessConfigurationError();
  }

  const issuer = env.CLOUDFLARE_ACCESS_ISSUER;
  const audience = env.CLOUDFLARE_ACCESS_AUDIENCE;
  if (issuer === undefined || audience === undefined) {
    throw new AccessConfigurationError();
  }

  return createCloudflareAccessVerifier(
    {
      issuer,
      audience,
      jwksUrl: env.CLOUDFLARE_ACCESS_JWKS_URL,
    },
    dependencies
  );
}
