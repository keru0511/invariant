import { describe, expect, it } from 'vitest';
import { handleMcpRequest } from './mcp';
import type { AccessPrincipal } from './access-auth';
import type { DomainSearchMatch, DomainVersionRecord } from '../persistence/domain-repository';
import { WorkspaceAccessError } from '../persistence/workspace-access';
import { parseDomain } from '../domain';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
} from '@modelcontextprotocol/server';

const TEST_ENV = {
  INVARIANT_ENVIRONMENT: 'test' as const,
  MCP_AUTH_MODE: 'test-bypass' as const,
};

const TEST_PRINCIPAL: AccessPrincipal = {
  subject: 'principal-a',
  issuer: 'https://test.cloudflareaccess.com',
  audience: 'test-audience',
  expiresAt: 1_900_000_000,
};

const parsedCatalog = (() => {
  const parsed = parseDomain(functionCatalog);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
})();

function createFakeWorkspaceRepository(options: {
  readonly authorizedWorkspace?: string;
  readonly model?: DomainVersionRecord['model'];
  readonly load?: (input: { readonly domainId: string; readonly versionId: string }) => Promise<DomainVersionRecord>;
  readonly search?: (input: { readonly query: string; readonly limit: number }) => Promise<readonly DomainSearchMatch[]>;
} = {}) {
  const authorizedWorkspace = options.authorizedWorkspace ?? 'workspace-a';
  const calls: Array<{
    readonly operation: string;
    readonly workspaceId?: string;
    readonly query?: string;
    readonly limit?: number;
  }> = [];
  return {
    calls,
    async forPrincipal(principal: AccessPrincipal, workspaceId: string) {
      calls.push({ operation: 'authorize', workspaceId });
      if (principal.subject !== TEST_PRINCIPAL.subject || workspaceId !== authorizedWorkspace) {
        throw new WorkspaceAccessError();
      }
      return {
        async loadVersion(input: { readonly domainId: string; readonly versionId: string }) {
          calls.push({ operation: 'loadVersion', workspaceId });
          if (options.load) return options.load(input);
          return {
            workspaceId,
            domainId: input.domainId,
            versionId: input.versionId,
            model: options.model ?? parsedCatalog,
            publishedAt: '2026-09-18T00:00:00.000Z',
          };
        },
        async search(input: { readonly query: string; readonly limit: number }) {
          calls.push({ operation: 'search', workspaceId, query: input.query, limit: input.limit });
          return options.search ? options.search(input) : [];
        },
      };
    },
  };
}

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

    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
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

    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'domain.ping',
            description: 'ドメインコアの疎通および健全性を確認',
          }),
          expect.objectContaining({
            name: 'domain.search',
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

    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
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

  it('AC: domain.search trims the query, authorizes first, returns metadata, and keeps explicit version IDs', async () => {
    const match: DomainSearchMatch = {
      domainId: 'orders',
      domainName: 'Customer Orders',
      versionId: 'v7',
      functionId: 'function.orders.member-age',
      functionName: 'member-age',
      description: 'Decide whether a member is an adult.',
    };
    const repository = createFakeWorkspaceRepository({
      search: async ({ query, limit }) => {
        expect(query).toBe('member');
        expect(limit).toBe(5);
        return [match];
      },
    });
    const response = await handleMcpRequest(createModernRequest({
      method: 'tools/call',
      name: 'domain.search',
      params: {
        name: 'domain.search',
        arguments: { workspace: 'workspace-a', query: '  member  ', limit: 5 },
      },
    }), TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(result).toEqual({
      status: 'ok',
      ok: true,
      workspace: 'workspace-a',
      query: 'member',
      limit: 5,
      results: [match],
      errors: [],
    });
    expect(repository.calls).toEqual([
      { operation: 'authorize', workspaceId: 'workspace-a' },
      { operation: 'search', workspaceId: 'workspace-a', query: 'member', limit: 5 },
    ]);
  });

  it.each([
    ['blank query', { workspace: 'workspace-a', query: '   ', limit: 5 }, 'INVALID_QUERY', 'query'],
    ['zero limit', { workspace: 'workspace-a', query: 'member', limit: 0 }, 'INVALID_LIMIT', 'limit'],
    ['over-limit', { workspace: 'workspace-a', query: 'member', limit: 101 }, 'INVALID_LIMIT', 'limit'],
    ['fractional limit', { workspace: 'workspace-a', query: 'member', limit: 1.5 }, 'INVALID_LIMIT', 'limit'],
  ] as const)('AC: domain.search rejects %s explicitly', async (_label, argumentsValue, code, path) => {
    const repository = createFakeWorkspaceRepository();
    const response = await handleMcpRequest(createModernRequest({
      method: 'tools/call',
      name: 'domain.search',
      params: { name: 'domain.search', arguments: argumentsValue },
    }), TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      status: 'error',
      ok: false,
      results: [],
      errors: [{ code, path }],
    });
    expect(repository.calls).toEqual([]);
  });

  it('AC: domain.search returns an empty list for no matches', async () => {
    const repository = createFakeWorkspaceRepository({ search: async () => [] });
    const response = await handleMcpRequest(createModernRequest({
      method: 'tools/call',
      name: 'domain.search',
      params: {
        name: 'domain.search',
        arguments: { workspace: 'workspace-a', query: 'does-not-match', limit: 10 },
      },
    }), TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(result).toMatchObject({ status: 'ok', ok: true, results: [], errors: [] });
  });

  it('AC: repeated domain.search calls are deterministic and limit results after authorization', async () => {
    const matches: readonly DomainSearchMatch[] = [
      {
        domainId: 'orders',
        domainName: 'Orders',
        versionId: 'v1',
        functionId: 'function.orders.refund',
        functionName: 'refund',
        description: 'Refund an order.',
      },
      {
        domainId: 'orders',
        domainName: 'Orders',
        versionId: 'v2',
        functionId: 'function.orders.refund',
        functionName: 'refund',
        description: 'Refund an order, revised.',
      },
      {
        domainId: 'orders',
        domainName: 'Orders',
        versionId: 'v3',
        functionId: 'function.orders.refund',
        functionName: 'refund',
        description: 'Refund an order, latest.',
      },
    ];
    const repository = createFakeWorkspaceRepository({
      search: async ({ limit }) => matches.slice(0, limit),
    });
    const request = () => handleMcpRequest(createModernRequest({
      method: 'tools/call',
      name: 'domain.search',
      params: {
        name: 'domain.search',
        arguments: { workspace: 'workspace-a', query: 'refund', limit: 2 },
      },
    }), TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });

    const firstResponse = await request();
    const secondResponse = await request();
    const firstBody = await firstResponse.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const secondBody = await secondResponse.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };

    expect(JSON.parse(firstBody.result.content[0].text)).toEqual(JSON.parse(secondBody.result.content[0].text));
    expect(JSON.parse(firstBody.result.content[0].text).results).toHaveLength(2);
    expect(repository.calls.filter((call) => call.operation === 'search')).toHaveLength(2);
  });

  it('AC: foreign workspace candidates are hidden before search storage access', async () => {
    const repository = createFakeWorkspaceRepository({ authorizedWorkspace: 'workspace-a' });
    const response = await handleMcpRequest(createModernRequest({
      method: 'tools/call',
      name: 'domain.search',
      params: {
        name: 'domain.search',
        arguments: { workspace: 'workspace-b', query: 'member', limit: 10 },
      },
    }), TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(result).toMatchObject({
      status: 'error',
      ok: false,
      results: [],
      errors: [{ code: 'RESOURCE_NOT_FOUND', message: 'Resource not found.' }],
    });
    expect(repository.calls).toEqual([{ operation: 'authorize', workspaceId: 'workspace-b' }]);
  });

  it('AC: domain.evaluate authorizes, loads the explicit version, and returns trace/provenance', async () => {
    const repository = createFakeWorkspaceRepository();
    const request = createModernRequest({
      method: 'tools/call',
      name: 'domain.evaluate',
      params: {
        name: 'domain.evaluate',
        arguments: {
          workspace: 'workspace-a',
          domain: 'orders',
          version: 'v1',
          function: 'member-age',
          args: { user: { age: 21 } },
        },
      },
    });

    const response = await handleMcpRequest(request, TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      status: 'resolved',
      decision: 'allow',
      value: true,
      workspace: 'workspace-a',
      domain: 'orders',
      version: 'v1',
      function: 'member-age',
      provenance: {
        functionId: 'function.domain-v0.member-age',
      },
    });
    expect(result.trace.length).toBeGreaterThan(0);
    expect(repository.calls).toEqual([
      { operation: 'authorize', workspaceId: 'workspace-a' },
      { operation: 'loadVersion', workspaceId: 'workspace-a' },
    ]);
  });

  it.each([
    [{ user: {} }, 'unresolved'],
    [{ user: { age: '21' } }, 'error'],
  ] as const)('AC: evaluator status and invalid args remain explicit (%s)', async (args, expectedStatus) => {
    const request = createModernRequest({
      method: 'tools/call',
      name: 'domain.evaluate',
      params: {
        name: 'domain.evaluate',
        arguments: {
          workspace: 'workspace-a',
          domain: 'orders',
          version: 'v1',
          function: 'member-age',
          args,
        },
      },
    });
    const response = await handleMcpRequest(request, TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: createFakeWorkspaceRepository(),
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(result.status).toBe(expectedStatus);
    expect(result.trace).toBeDefined();
    expect(result.provenance).toBeDefined();
    if (expectedStatus === 'error') {
      expect(result.errors[0]).toMatchObject({ code: 'TYPE_MISMATCH', path: 'user.age' });
    }
  });

  it('AC: invalid function and version are explicit tool errors', async () => {
    const repository = createFakeWorkspaceRepository();
    const request = createModernRequest({
      method: 'tools/call',
      name: 'domain.evaluate',
      params: {
        name: 'domain.evaluate',
        arguments: {
          workspace: 'workspace-a',
          domain: 'orders',
          version: ' ',
          function: 'does-not-exist',
          args: {},
        },
      },
    });
    const response = await handleMcpRequest(request, TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(result).toMatchObject({ status: 'error', errors: [{ code: 'INVALID_VERSION', path: 'version' }] });
    expect(repository.calls).toEqual([]);
  });

  it('AC: an invalid function is returned explicitly after authorized version load', async () => {
    const repository = createFakeWorkspaceRepository();
    const request = createModernRequest({
      method: 'tools/call',
      name: 'domain.evaluate',
      params: {
        name: 'domain.evaluate',
        arguments: {
          workspace: 'workspace-a',
          domain: 'orders',
          version: 'v1',
          function: 'does-not-exist',
          args: {},
        },
      },
    });
    const response = await handleMcpRequest(request, TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(result).toMatchObject({ status: 'error', errors: [{ code: 'INVALID_FUNCTION' }] });
    expect(repository.calls).toEqual([
      { operation: 'authorize', workspaceId: 'workspace-a' },
      { operation: 'loadVersion', workspaceId: 'workspace-a' },
    ]);
  });

  it('AC: ambiguous function names are returned as ambiguous', async () => {
    const ambiguousInput = JSON.parse(JSON.stringify(functionCatalog)) as {
      functions: Array<{ name: string }>;
    };
    ambiguousInput.functions[1].name = ambiguousInput.functions[0].name;
    const ambiguousCatalog = parseDomain(ambiguousInput);
    if (!ambiguousCatalog.ok) throw new Error(ambiguousCatalog.error.message);

    const request = createModernRequest({
      method: 'tools/call',
      name: 'domain.evaluate',
      params: {
        name: 'domain.evaluate',
        arguments: {
          workspace: 'workspace-a',
          domain: 'orders',
          version: 'v1',
          function: 'member-age',
          args: { user: { age: 21 } },
        },
      },
    });
    const response = await handleMcpRequest(request, TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: createFakeWorkspaceRepository({ model: ambiguousCatalog.value }),
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(result).toMatchObject({
      status: 'ambiguous',
      errors: [{ code: 'INVALID_FUNCTION' }],
    });
    expect(result.errors[0].message).toContain('ambiguous');
  });

  it('AC: cross-workspace access does not leak existence or load data', async () => {
    const repository = createFakeWorkspaceRepository({ authorizedWorkspace: 'workspace-a' });
    const request = createModernRequest({
      method: 'tools/call',
      name: 'domain.evaluate',
      params: {
        name: 'domain.evaluate',
        arguments: {
          workspace: 'workspace-b',
          domain: 'orders',
          version: 'v1',
          function: 'member-age',
          args: { user: { age: 21 } },
        },
      },
    });
    const response = await handleMcpRequest(request, TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(result).toMatchObject({
      status: 'error',
      errors: [{ code: 'RESOURCE_NOT_FOUND', message: 'Resource not found.' }],
    });
    expect(JSON.stringify(result)).not.toContain('workspace-a');
    expect(repository.calls).toEqual([{ operation: 'authorize', workspaceId: 'workspace-b' }]);
  });

  it('AC: storage failures are explicit and do not expose backend details', async () => {
    const repository = createFakeWorkspaceRepository({
      load: async () => { throw new Error('secret SQL details'); },
    });
    const request = createModernRequest({
      method: 'tools/call',
      name: 'domain.evaluate',
      params: {
        name: 'domain.evaluate',
        arguments: {
          workspace: 'workspace-a',
          domain: 'orders',
          version: 'v1',
          function: 'member-age',
          args: { user: { age: 21 } },
        },
      },
    });
    const response = await handleMcpRequest(request, TEST_ENV, {
      accessVerifier: { verify: async () => TEST_PRINCIPAL },
      workspaceRepository: repository,
    });
    const body = await response.json() as { readonly result: { readonly content: readonly [{ readonly text: string }] } };
    const result = JSON.parse(body.result.content[0].text);

    expect(result).toMatchObject({ status: 'error', errors: [{ code: 'STORAGE_FAILURE' }] });
    expect(JSON.stringify(result)).not.toContain('secret SQL details');
  });
});
