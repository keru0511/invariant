import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ping } from '../domain';

export const MCP_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, mcp-session-id, mcp-protocol-version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Content-Type, mcp-session-id, mcp-protocol-version',
};

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'invariant-mcp',
    version: '0.0.1',
  });

  server.tool(
    'domain.ping',
    'ドメインコアの疎通および健全性を確認',
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

export async function handleMcpRequest(request: Request): Promise<Response> {
  // CORS プリフライトリクエストの処理
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...MCP_CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // ステートレス Streamable HTTP
  });

  await server.connect(transport);
  const response = await transport.handleRequest(request);

  // レスポンスに CORS ヘッダーを付与
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
