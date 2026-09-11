import { describe, expect, it } from 'vitest';
import handler from './index';

describe('Worker (Cloudflare Worker ハンドラー)', () => {
  it('GET / に対し status ok とドメインメタデータを返却する', async () => {
    const request = new Request('http://localhost/');
    const env = {};
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await handler.fetch!(request as any, env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      status: 'ok',
      service: 'invariant',
      domain: {
        name: 'invariant-domain-core',
        version: '0.0.1',
        status: 'ready',
      },
    });
  });

  it('GET /health を正常に処理する', async () => {
    const request = new Request('http://localhost/health');
    const env = {};
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await handler.fetch!(request as any, env, ctx);
    expect(response.status).toBe(200);
  });

  it('未定義のルートに対して 404 を返却する', async () => {
    const request = new Request('http://localhost/unknown');
    const env = {};
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await handler.fetch!(request as any, env, ctx);
    expect(response.status).toBe(404);
  });

  it('/health に対する GET 以外のリクエストに対して 404 を返却する', async () => {
    const request = new Request('http://localhost/health', { method: 'POST' });
    const env = {};
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await handler.fetch!(request as any, env, ctx);
    expect(response.status).toBe(404);
  });

  it('/mcp へのリクエストを MCP ハンドラーにルーティングする', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    });
    const env = {};
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await handler.fetch!(request as any, env, ctx);
    expect(response.status).toBe(204);
  });
});
