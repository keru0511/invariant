import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SMOKE_CONTRACT,
  SmokeError,
  main,
  normalizeDeploymentUrl,
  runDeploymentSmoke,
} from './deployment-smoke.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function passingFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/health')) {
      return jsonResponse({ status: 'ok', service: 'invariant' });
    }
    return jsonResponse({
      jsonrpc: '2.0',
      id: 'deployment-smoke',
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
    });
  };
}

describe('deployment smoke contract', () => {
  it('normalizes only absolute http(s) deployment URLs', () => {
    expect(normalizeDeploymentUrl('https://invariant.example.workers.dev/')).toBe(
      'https://invariant.example.workers.dev',
    );
    expect(() => normalizeDeploymentUrl('')).toThrowError(SmokeError);
    expect(() => normalizeDeploymentUrl('workers.dev')).toThrowError(SmokeError);
    expect(() => normalizeDeploymentUrl('https://example.test/?token=secret')).toThrowError(SmokeError);
  });

  it('checks health and MCP domain.ping with a deterministic request contract', async () => {
    const calls = [];
    const result = await runDeploymentSmoke('https://invariant.example.workers.dev/', {
      fetchImpl: passingFetch(calls),
    });

    expect(result).toEqual({
      ok: true,
      baseUrl: 'https://invariant.example.workers.dev',
      checks: {
        health: {
          path: '/health',
          status: 200,
          observed: { status: 'ok', service: 'invariant' },
        },
        mcpPing: {
          path: '/mcp',
          status: 200,
          tool: 'domain.ping',
          observed: { text: '{"ok":true}' },
        },
      },
    });
    expect(calls.map(({ url }) => url)).toEqual([
      'https://invariant.example.workers.dev/health',
      'https://invariant.example.workers.dev/mcp',
    ]);
    expect(calls[0].init).toMatchObject({ method: 'GET' });
    expect(calls[1].init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: SMOKE_CONTRACT.origin,
        'MCP-Protocol-Version': SMOKE_CONTRACT.protocolVersion,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'domain.ping',
      },
    });
    expect(JSON.parse(calls[1].init.body)).toEqual({
      jsonrpc: '2.0',
      id: 'deployment-smoke',
      method: 'tools/call',
      params: {
        name: 'domain.ping',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': {
            name: 'invariant-deployment-smoke',
            version: '1.0.0',
          },
        },
      },
    });
  });

  it('fails closed when health or MCP does not meet the contract', async () => {
    await expect(runDeploymentSmoke('https://invariant.example.workers.dev', {
      fetchImpl: async () => jsonResponse({ status: 'down' }, 503),
    })).rejects.toMatchObject({ code: 'health-http' });

    let requestCount = 0;
    await expect(runDeploymentSmoke('https://invariant.example.workers.dev', {
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? jsonResponse({ status: 'ok', service: 'invariant' })
          : jsonResponse({ jsonrpc: '2.0', result: { content: [{ type: 'text', text: '{"ok":false}' }] } });
      },
    })).rejects.toMatchObject({ code: 'mcp-ping-body' });
  });

  it('returns exit 2 without a URL and exit 0 only for a complete mocked smoke', async () => {
    const missingOutput = { stdout: [], stderr: [] };
    await expect(main([], {}, globalThis.fetch, {
      stdout: (value) => missingOutput.stdout.push(value),
      stderr: (value) => missingOutput.stderr.push(value),
    })).resolves.toBe(2);
    expect(missingOutput.stdout).toEqual([]);
    expect(missingOutput.stderr.join('')).toContain('"code": "usage"');

    const successOutput = { stdout: [], stderr: [] };
    await expect(main(['https://invariant.example.workers.dev'], {}, passingFetch([]), {
      stdout: (value) => successOutput.stdout.push(value),
      stderr: (value) => successOutput.stderr.push(value),
    })).resolves.toBe(0);
    expect(JSON.parse(successOutput.stdout.join(''))).toMatchObject({ ok: true });
    expect(successOutput.stderr).toEqual([]);
  });
});

describe('deployment runbook and config', () => {
  it('commits the exact production branch, build boundary, and account-side status', async () => {
    const [runbook, workflow, wrangler] = await Promise.all([
      readFile(join(repoRoot, 'docs/deployment.md'), 'utf8'),
      readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'),
      readFile(join(repoRoot, 'wrangler.jsonc'), 'utf8'),
    ]);

    expect(runbook).toContain('| Production branch | `main` |');
    expect(runbook).toContain('`CI / quality`');
    expect(runbook).toContain('`npm ci && npm run typecheck && npm test`');
    expect(runbook).toContain('`npx wrangler deploy`');
    expect(runbook).toContain('npm run smoke:deployment -- <deployment-url>');
    expect(runbook).toContain('NOT RUN');
    expect(runbook).toContain('| Secrets in this repository | None;');
    expect(workflow).not.toMatch(/wrangler deploy|secrets\.|cloudflare/i);
    expect(wrangler).toContain('"name": "invariant"');
    expect(wrangler).toContain('"main": "src/worker/index.ts"');
  });
});
