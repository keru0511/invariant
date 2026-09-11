import { describe, expect, it } from 'vitest';
import {
  handleMcpRequest,
  createMcpServer,
  ALLOWED_ORIGIN_HOSTNAMES,
} from './mcp';
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';

describe('MCP ハンドラー (/mcp)', () => {
  it('domain.ping ツールが登録された McpServer インスタンスを生成する', () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  it('CORS OPTIONS プリフライトリクエストに対して 204 と Mcp-Method/Mcp-Name を含む許可ヘッダーを返却する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers':
          'Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
      },
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:5173'
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    const allowHeaders = response.headers.get('Access-Control-Allow-Headers');
    expect(allowHeaders).toContain('Mcp-Method');
    expect(allowHeaders).toContain('Mcp-Name');
    expect(allowHeaders).toContain('MCP-Protocol-Version');
  });

  it('許可されていない Origin からのリクエストに対して 403 を返却する (DNS Rebinding 対策)', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.com',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: expect.stringContaining('Invalid Origin'),
      },
    });
  });

  it('許可されていない Origin からの OPTIONS プリフライトに対しても 403 を返却する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://malicious-site.example.org',
        'Access-Control-Request-Method': 'POST',
      },
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(403);
  });

  it('modern MCP 2026-07-28 形式で tools/list を直接実行し JSON レスポンスを返却する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: { name: 'modern-test-client', version: '1.0.0' },
          },
        },
      }),
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:5173'
    );

    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: '1',
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'domain.ping',
            description: 'ドメインコアの疎通および健全性を確認',
          }),
        ]),
      },
    });
  });

  it('modern MCP 2026-07-28 形式で domain.ping を tools/call 実行し、決定論的 JSON 結果 { ok: true } を返却する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'domain.ping',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call',
        params: {
          name: 'domain.ping',
          arguments: {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: { name: 'modern-test-client', version: '1.0.0' },
          },
        },
      }),
    });

    const response = await handleMcpRequest(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');

    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: '2',
      result: {
        content: [
          {
            type: 'text',
            text: '{"ok":true}',
          },
        ],
        _meta: {
          [SERVER_INFO_META_KEY]: {
            name: 'invariant-mcp',
            version: '0.0.1',
          },
        },
      },
    });
  });

  it('legacy Streamable HTTP クライアントとの後方互換性 (SSE形式) も正常に処理する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
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
    expect(text).toContain('{\\"ok\\":true}');
  });
});
