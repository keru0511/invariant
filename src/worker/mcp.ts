import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
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

  const response = await mcpHandler.fetch(request);

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
