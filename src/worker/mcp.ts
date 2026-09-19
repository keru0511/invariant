import {
  McpServer,
  createMcpHandler,
  originValidationResponse,
  localhostAllowedOrigins,
} from '@modelcontextprotocol/server';
import type { AuthInfo, McpRequestContext } from '@modelcontextprotocol/server';
import { ping } from '../domain';
import {
  CF_ACCESS_JWT_ASSERTION_HEADER,
  createAccessTokenVerifier,
} from './access-auth';
import type { AccessPrincipal, AccessTokenVerifier } from './access-auth';
import type { Env } from './env';

const ALLOWED_ORIGIN_HOSTNAMES = localhostAllowedOrigins();

function getCorsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Cf-Access-Jwt-Assertion',
  };
}

export const VERIFIED_PRINCIPAL_AUTH_INFO_KEY = 'invariantAccessPrincipal';

export interface McpRequestDependencies {
  /** Test-only seam; production requests must resolve the configured provider. */
  readonly accessVerifier?: AccessTokenVerifier;
}

export function getVerifiedAccessPrincipal(
  context: McpRequestContext
): AccessPrincipal | undefined {
  return context.authInfo?.extra?.[VERIFIED_PRINCIPAL_AUTH_INFO_KEY] as
    | AccessPrincipal
    | undefined;
}

function createMcpServer(context: McpRequestContext): McpServer {
  const principal = getVerifiedAccessPrincipal(context);
  if (principal === undefined) {
    // This should be unreachable because authentication happens before the
    // SDK handler is called. Keep the application boundary fail closed too.
    throw new Error('MCP request has no verified principal');
  }

  const server = new McpServer({
    name: 'invariant-mcp',
    version: '0.0.1',
  });

  server.registerTool(
    'domain.ping',
    {
      description: 'ドメインコアの疎通および健全性を確認',
    },
    async () => {
      // The verified principal is available to every request-scoped tool via
      // this closure without trusting caller-provided identity headers.
      void principal;
      const result = ping();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(
  (context) => createMcpServer(context),
  { legacy: 'reject' }
);

function authenticationFailureResponse(corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Unauthorized',
      },
    }),
    {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      },
    }
  );
}

function createMcpAuthInfo(request: Request, principal: AccessPrincipal): AuthInfo {
  return {
    // The MCP SDK requires the token field for its standard auth context. The
    // raw token is kept request-scoped and is never returned in an MCP result.
    token: request.headers.get(CF_ACCESS_JWT_ASSERTION_HEADER) ?? 'test-bypass',
    clientId: principal.subject,
    scopes: [],
    expiresAt: principal.expiresAt,
    extra: {
      [VERIFIED_PRINCIPAL_AUTH_INFO_KEY]: principal,
    },
  };
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  dependencies: McpRequestDependencies = {}
): Promise<Response> {
  // DNS Rebinding 対策: Origin ヘッダーの検証 (不正な場合は 403 を返却)
  const originRejection = originValidationResponse(request, ALLOWED_ORIGIN_HOSTNAMES);
  if (originRejection) {
    return originRejection;
  }

  const origin = request.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  // CORS プリフライトリクエストの処理
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  let principal: AccessPrincipal;
  try {
    // Injected providers are a test seam only. A production request cannot
    // replace the configured Cloudflare Access provider at runtime.
    if (dependencies.accessVerifier !== undefined && env.INVARIANT_ENVIRONMENT !== 'test') {
      throw new Error('injected verifier is test-only');
    }
    const verifier = dependencies.accessVerifier ?? createAccessTokenVerifier(env);
    principal = await verifier.verify(request);
  } catch {
    // Do not expose whether the failure was a missing token, bad claim, bad
    // signature, JWKS outage, or invalid Worker configuration.
    return authenticationFailureResponse(corsHeaders);
  }

  const response = await mcpHandler.fetch(request, {
    authInfo: createMcpAuthInfo(request, principal),
  });

  // レスポンスに CORS ヘッダーを付与
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
