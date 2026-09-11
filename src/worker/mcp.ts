import {
  McpServer,
  createMcpHandler,
  originValidationResponse,
  localhostAllowedOrigins,
} from '@modelcontextprotocol/server';
import { ping } from '../domain';

/**
 * DNS Rebinding 対策のための許可 Origin ホスト名リスト
 */
export const ALLOWED_ORIGIN_HOSTNAMES: readonly string[] = [
  ...localhostAllowedOrigins(),
];

export function getCorsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, mcp-session-id, mcp-protocol-version, Last-Event-ID',
    'Access-Control-Expose-Headers':
      'Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, mcp-session-id, mcp-protocol-version',
  };
}

export function createMcpServer(): McpServer {
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

const mcpHandler = createMcpHandler(async () => createMcpServer());

export async function handleMcpRequest(
  request: Request,
  allowedOrigins: readonly string[] = ALLOWED_ORIGIN_HOSTNAMES
): Promise<Response> {
  // DNS Rebinding 対策: Origin ヘッダーの検証 (不正な場合は 403 を返却)
  const originRejection = originValidationResponse(request, [...allowedOrigins]);
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

  const response = await mcpHandler.fetch(request);

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
