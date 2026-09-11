import { describe, expect, it } from 'vitest';
import { handleMcpRequest, createMcpServer } from './mcp';

describe('MCP Handler', () => {
  it('creates an McpServer instance with domain.ping tool registered', () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  it('handles CORS OPTIONS preflight request with 204 and headers', async () => {
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

  it('handles initialize request over Streamable HTTP', async () => {
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
          protocolVersion: '2024-11-05',
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
    expect(text).toContain('"protocolVersion":"2024-11-05"');
  });

  it('exposes domain.ping in tools/list', async () => {
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
    expect(text).toContain('Check domain connectivity and health');
  });

  it('executes domain.ping via tools/call returning deterministic { ok: true }', async () => {
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
    // Verify JSON-RPC response contains { ok: true }
    expect(text).toContain('{\\"ok\\":true}');
  });
});
