import { beforeAll, describe, expect, it } from 'vitest';
import {
  CF_ACCESS_JWT_ASSERTION_HEADER,
  createAccessTokenVerifier,
  createCloudflareAccessVerifier,
} from './access-auth';
import type { AccessJwk, AccessPrincipal, AccessTokenVerifier } from './access-auth';
import { handleMcpRequest } from './mcp';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

const ISSUER = 'https://test.cloudflareaccess.com';
const AUDIENCE = 'test-audience-tag';
const KEY_ID = 'test-key-id';
const NOW = 1_800_000_000;

const ACCESS_TEST_ENV = {
  INVARIANT_ENVIRONMENT: 'test' as const,
  MCP_AUTH_MODE: 'cloudflare-access' as const,
  CLOUDFLARE_ACCESS_ISSUER: ISSUER,
  CLOUDFLARE_ACCESS_AUDIENCE: AUDIENCE,
};

const PRODUCTION_BYPASS_ENV = {
  INVARIANT_ENVIRONMENT: 'production' as const,
  MCP_AUTH_MODE: 'test-bypass' as const,
};

let signingKey: CryptoKey;
let publicJwk: AccessJwk;

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function createAccessToken(
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-123',
    email: 'test@example.invalid',
    iat: NOW - 1,
    exp: NOW + 300,
    ...overrides,
  };
  const encodedHeader = encodeJson(header);
  const encodedPayload = encodeJson(payload);
  const input = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    signingKey,
    input
  );
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function tamperSignature(token: string): string {
  const segments = token.split('.');
  if (segments.length !== 3 || segments[2].length === 0) {
    throw new Error('expected a JWT with a non-empty signature');
  }

  // Mutate the first signature character. Mutating only the final base64url
  // character can leave the decoded signature unchanged because its trailing
  // bits may be padding bits.
  const replacement = segments[2][0] === 'A' ? 'B' : 'A';
  segments[2] = `${replacement}${segments[2].slice(1)}`;
  return segments.join('.');
}

function createModernPingRequest(token?: string): Request {
  const headers: Record<string, string> = {
    Origin: 'http://localhost:5173',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/call',
    'Mcp-Name': 'domain.ping',
  };
  if (token !== undefined) headers[CF_ACCESS_JWT_ASSERTION_HEADER] = token;

  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'auth-test',
      method: 'tools/call',
      params: {
        name: 'domain.ping',
        arguments: {},
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: 'auth-test', version: '1.0.0' },
        },
      },
    }),
  });
}

function createVerifier(): AccessTokenVerifier {
  return createCloudflareAccessVerifier(
    {
      issuer: ISSUER,
      audience: AUDIENCE,
    },
    {
      now: () => NOW,
      jwksProvider: {
        async getJwks() {
          return { keys: [publicJwk] };
        },
      },
    }
  );
}

async function expectUnauthorized(request: Request, verifier = createVerifier()): Promise<void> {
  const response = await handleMcpRequest(request, ACCESS_TEST_ENV, {
    accessVerifier: verifier,
  });
  expect(response.status).toBe(401);
  expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  expect(await response.json()).toEqual({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Unauthorized' },
  });
}

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;
  signingKey = keyPair.privateKey;
  publicJwk = {
    ...await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey,
    kid: KEY_ID,
    alg: 'RS256',
    use: 'sig',
  };
});

describe('Cloudflare Access provider boundary', () => {
  it('validates a network-free test JWKS and reaches domain.ping', async () => {
    const token = await createAccessToken();
    const response = await handleMcpRequest(
      createModernPingRequest(token),
      ACCESS_TEST_ENV,
      { accessVerifier: createVerifier() }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        content: [{ type: 'text', text: '{"ok":true}' }],
      },
    });
  });

  it('rejects a signature mutation that changes decoded signature bytes', async () => {
    const validToken = await createAccessToken();
    const forgedToken = tamperSignature(validToken);

    expect(forgedToken).not.toBe(validToken);
    await expectUnauthorized(createModernPingRequest(forgedToken));
  });

  it('rejects missing, expired, wrong-issuer, and wrong-audience identities', async () => {
    await expectUnauthorized(createModernPingRequest());
    await expectUnauthorized(createModernPingRequest(await createAccessToken({ exp: NOW })));
    await expectUnauthorized(
      createModernPingRequest(await createAccessToken({ iss: 'https://other.cloudflareaccess.com' }))
    );
    await expectUnauthorized(createModernPingRequest(await createAccessToken({ aud: 'other-audience' })));
  });

  it('fails closed when the verification provider fails', async () => {
    const failingVerifier: AccessTokenVerifier = {
      async verify(): Promise<AccessPrincipal> {
        throw new Error('JWKS unavailable');
      },
    };
    await expectUnauthorized(createModernPingRequest('unusable'), failingVerifier);
  });

  it('cannot enable the test bypass in production mode', async () => {
    const bypassVerifier: AccessTokenVerifier = {
      async verify(): Promise<AccessPrincipal> {
        return {
          subject: 'should-not-be-used',
          issuer: ISSUER,
          audience: AUDIENCE,
          expiresAt: NOW + 300,
        };
      },
    };

    const response = await handleMcpRequest(
      createModernPingRequest(),
      PRODUCTION_BYPASS_ENV,
      { accessVerifier: bypassVerifier }
    );
    expect(response.status).toBe(401);
    expect(() => createAccessTokenVerifier(PRODUCTION_BYPASS_ENV)).toThrow();
  });
});
