import { describe, expect, it } from 'vitest';
import { handleMcpRequest, createMcpServer } from './mcp';

describe('MCP ハンドラー (/mcp)', () => {
  it('domain.ping ツールが登録された McpServer インスタンスを生成する', () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  it('CORS OPTIONS プリフライトリクエストに対して 204 と適切なヘッダーを返却する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('Streamable HTTP 経由での initialize リクエスト (2026-07-28) を処理する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const text = await response.text();
    expect(text).toContain('event: message');
    expect(text).toContain('"name":"invariant-mcp"');
    // サーバーがネゴシエーションした protocolVersion を含むこと
    expect(text).toContain('"protocolVersion":');
  });

  it('tools/list にて domain.ping ツールを公開する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toContain('event: message');
    expect(text).toContain('"name":"domain.ping"');
    expect(text).toContain('ドメインコアの疎通および健全性を確認');
  });

  it('tools/call 経由で domain.ping を実行し、決定論的に { ok: true } を返却する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'domain.ping',
          arguments: {},
        },
      }),
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toContain('event: message');
    // JSON-RPC レスポンスに { ok: true } が含まれることを検証
    expect(text).toContain('{\\"ok\\":true}');
  });
});
