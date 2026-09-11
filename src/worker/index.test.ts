import { describe, expect, it } from 'vitest';
import handler from './index';

describe('Worker', () => {
  it('handles GET / with status ok and domain metadata', async () => {
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

  it('handles GET /health', async () => {
    const request = new Request('http://localhost/health');
    const env = {};
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await handler.fetch!(request as any, env, ctx);
    expect(response.status).toBe(200);
  });

  it('returns 404 for unknown routes', async () => {
    const request = new Request('http://localhost/unknown');
    const env = {};
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await handler.fetch!(request as any, env, ctx);
    expect(response.status).toBe(404);
  });
});
