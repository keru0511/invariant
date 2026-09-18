import { describe, expect, it } from 'vitest';
import { handleMcpRequest } from './mcp';
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
} from '@modelcontextprotocol/server';

const TEST_ENV = {
  INVARIANT_ENVIRONMENT: 'test' as const,
  MCP_AUTH_MODE: 'test-bypass' as const,
};

/**
 * 2026-07-28 Modern MCP リクエストを生成するテストヘルパー
 */
function createModernRequest(options: {
  method: string;
  params?: Record<string, unknown>;
  name?: string;
  origin?: string;
}): Request {
  const headers: Record<string, string> = {
    Origin: options.origin ?? 'http://localhost:5173',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': options.method,
  };

  if (options.name) {
    headers['Mcp-Name'] = options.name;
  }

  const body = {
    jsonrpc: '2.0',
    id: '1',
    method: options.method,
    params: {
      ...options.params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
        [CLIENT_CAPABILITIES_META_KEY]: {},
        [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
      },
    },
  };

  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('MCP ハンドラー (/mcp)', () => {
  it('CORS OPTIONS プリフライトに対して 204 と Mcp-Method/Mcp-Name を含む許可ヘッダーを返却する', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers':
          'Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
      },
    });

    const response = await handleMcpRequest(request, TEST_ENV);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:5173'
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    const allowHeaders = response.headers.get('Access-Control-Allow-Headers');
    expect(allowHeaders).toContain('Mcp-Method');
    expect(allowHeaders).toContain('Mcp-Name');
    expect(allowHeaders).toContain('MCP-Protocol-Version');
  });

  it('許可されていない Origin からのリクエストに対して 403 を返却する (DNS Rebinding 対策)', async () => {
    const request = createModernRequest({
      method: 'tools/list',
      origin: 'https://evil.com',
    });

    const response = await handleMcpRequest(request, TEST_ENV);
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

  it('modern MCP 2026-07-28 形式で tools/list を実行し、登録された domain.ping ツールを返却する', async () => {
    const request = createModernRequest({
      method: 'tools/list',
    });

    const response = await handleMcpRequest(request, TEST_ENV);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:5173'
    );

    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
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

  it('modern MCP 2026-07-28 形式で domain.ping を実行し、決定論的結果 { ok: true } を返却する', async () => {
    const request = createModernRequest({
      method: 'tools/call',
      name: 'domain.ping',
      params: {
        name: 'domain.ping',
        arguments: {},
      },
    });

    const response = await handleMcpRequest(request, TEST_ENV);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');

    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      result: {
        content: [
          {
            type: 'text',
            text: '{"ok":true}',
          },
        ],
      },
    });
  });
});
