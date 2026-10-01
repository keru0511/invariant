import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { readFileSync } from 'node:fs';
import { D1DomainRepository } from '../persistence/domain-repository';
import { D1ProposalRepository } from '../persistence/domain-proposals';
import { AuthWorkspaceRepositoryAdapter, D1WorkspaceMembershipRepository } from '../persistence/workspace-access';
import { proposeDomain, commitDomain, proposeInputSchema, commitInputSchema } from './domain-authoring';
import { handleMcpRequest } from './mcp';
import { createOpenAICompatibleProvider } from '../provider';
import { PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';

const catalog = JSON.parse(readFileSync(new URL('../../fixtures/domain-v0/functions.json', import.meta.url), 'utf8'));
const principal = { subject: 'alice', issuer: 'test', audience: 'test', expiresAt: 1900000000 };
const env = { INVARIANT_ENVIRONMENT: 'test', MCP_AUTH_MODE: 'test-bypass' };
const input = { workspace: 'w', domain: 'd', baseVersion: 'v1', conversation: [
  { id: 't1', role: 'user', content: 'Require manual review for everyone. Country is unknown.' },
] };
const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// Use real SQLite (including transactions, FKs, triggers, and INSERT SELECT),
// not a SQL-string mock: concurrency guarantees depend on database semantics.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of ['0001_domain_persistence.sql', '0002_workspace_memberships.sql', '0003_domain_proposals.sql']) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const prepare = (sql, values = []) => ({
    bind: (...args) => prepare(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({ success: true, meta: sqlite.prepare(sql).run(...values) }),
  });
  const db = { prepare, batch: async (statements) => {
    sqlite.exec('BEGIN');
    try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } };
  return { db, sqlite };
}
function output(request, suffix = '') {
  return { patch: {
    contractVersion: 'domain-patch-v0', kind: 'domain-patch', baseVersion: request.currentDomainVersion,
    provenance: { source: 'conversation', reference: request.conversation[0].id },
    operations: [
      { op: 'add_rule', functionId: 'function.domain-v0.member-age', rule: {
        id: `rule.review${suffix}`, priority: 999, when: { id: `node.review${suffix}`, kind: 'literal', value: true }, then: 'deny',
      } },
      { op: 'mark_unknown', unknown: { id: `unknown.country${suffix}`, kind: 'unknown', subject: 'country', description: 'Country is unspecified' } },
    ],
  }, operationEvidence: [0, 1].map((operationIndex) => ({ operationIndex, sourceReferences: [request.conversation[0].id] })) };
}
async function setup(generate = async (request) => output(request)) {
  const { db, sqlite } = database();
  const domains = new D1DomainRepository(db);
  await domains.publishVersion({ workspaceId: 'w', domainId: 'd', versionId: 'v1', model: catalog });
  sqlite.prepare('INSERT INTO workspace_memberships VALUES (?, ?, ?)').run('w', 'alice', 'now');
  const repository = new AuthWorkspaceRepositoryAdapter(new D1WorkspaceMembershipRepository(db), domains);
  const proposals = new D1ProposalRepository(db);
  const provider = { generate: vi.fn(generate) };
  const dependencies = { repository, proposals, provider: () => provider };
  return { db, sqlite, domains, proposals, provider, dependencies };
}
function confirmation(proposed) {
  return { workspace: 'w', domain: 'd', proposalId: proposed.proposalId, reviewDigest: proposed.reviewDigest, confirmed: true };
}
function request(name, args) {
  return new Request('http://localhost/mcp', { method: 'POST', headers: {
    Origin: 'http://localhost:5173', 'Content-Type': 'application/json', Accept: 'application/json',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: {
    name, arguments: args, _meta: {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {},
      [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' },
    },
  } }) });
}
async function call(name, args, setup) {
  const response = await handleMcpRequest(request(name, args), env, {
    accessVerifier: { verify: async () => principal },
    workspaceRepository: setup.dependencies.repository, authoring: setup.dependencies,
  });
  const body = await response.json();
  if (body.error) return body;
  if (body.result.isError && !body.result.content[0].text.startsWith('{')) return body.result;
  return { ...body.result, value: JSON.parse(body.result.content[0].text) };
}

describe('reviewed domain authoring', () => {
  it('MCP propose -> explicit commit -> evaluate, without changing the base', async () => {
    const s = await setup();
    const proposed = (await call('domain.propose', input, s)).value;
    expect(proposed.status).toBe('proposed');
    expect(proposed.requiresConfirmation).toBe(true);
    expect(proposed.review.sources).toEqual(input.conversation);
    expect(proposed.review.unknowns).toHaveLength(1);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM domain_versions').get().n).toBe(1);
    const before = (await call('domain.evaluate', { workspace: 'w', domain: 'd', version: 'v1', function: 'member-age', args: { user: { age: 20 } } }, s)).value;
    expect(before.decision).toBe('allow');
    const committed = (await call('domain.commit', confirmation(proposed), s)).value;
    expect(committed.status).toBe('committed');
    const evaluated = (await call('domain.evaluate', { workspace: 'w', domain: 'd', version: committed.version, function: 'member-age', args: { user: { age: 20 } } }, s)).value;
    expect(evaluated.status).toBe('unresolved');
    expect(evaluated.decision).toBeUndefined();
    expect(evaluated.value).toBeNull();
    expect(evaluated.errors[0].code).toBe('DOMAIN_KNOWLEDGE_INCOMPLETE');
    expect(evaluated.knowledgeIssues.unknowns[0].id).toBe('unknown.country');
    expect(await s.proposals.head({ workspaceId: 'w', domainId: 'd' })).toBe(committed.version);
  });

  it('rejects omitted/false approval, changed digest and client-supplied replacement models', async () => {
    const s = await setup();
    const proposed = await proposeDomain(input, principal, s.dependencies);
    for (const confirmed of [undefined, false]) {
      expect(commitInputSchema.safeParse({ ...confirmation(proposed), confirmed }).success).toBe(false);
      const result = await call('domain.commit', { ...confirmation(proposed), confirmed }, s);
      expect(result.error || result.isError).toBeTruthy();
    }
    expect(commitInputSchema.safeParse({ ...confirmation(proposed), model: catalog }).success).toBe(false);
    expect(await commitDomain({ ...confirmation(proposed), reviewDigest: '0'.repeat(64) }, principal, s.dependencies))
      .toMatchObject({ error: { code: 'REVIEW_MISMATCH' } });
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM domain_versions').get().n).toBe(1);
  });

  it('rejects stale bases including versions published outside the authoring API', async () => {
    const s = await setup();
    const proposed = await proposeDomain(input, principal, s.dependencies);
    await s.domains.publishVersion({ workspaceId: 'w', domainId: 'd', versionId: 'external', model: catalog });
    expect(await commitDomain(confirmation(proposed), principal, s.dependencies)).toMatchObject({ error: { code: 'STALE_BASE_VERSION' } });
    expect(await proposeDomain(input, principal, s.dependencies)).toMatchObject({ error: { code: 'STALE_BASE_VERSION' } });
    expect(s.provider.generate).toHaveBeenCalledTimes(1);
  });

  it('only commits one of two competing proposals and safely replays the winner', async () => {
    const s = await setup();
    const a = await proposeDomain(input, principal, s.dependencies);
    const b = await proposeDomain(input, principal, s.dependencies);
    const results = await Promise.all([a, b].map((p) => commitDomain(confirmation(p), principal, s.dependencies)));
    expect(results.map((r) => r.status).sort()).toEqual(['committed', 'error']);
    expect(results.find((r) => r.status === 'error').error.code).toBe('STALE_BASE_VERSION');
    const winner = results[0].status === 'committed' ? a : b;
    await s.domains.publishVersion({ workspaceId: 'w', domainId: 'd', versionId: 'later', model: catalog });
    const replay = await commitDomain(confirmation(winner), principal, s.dependencies);
    expect(replay.version).toBe(winner.review.version);
    expect(await s.proposals.head({ workspaceId: 'w', domainId: 'd' })).toBe('later');
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM domain_versions').get().n).toBe(3);
  });

  it('preserves unknowns and permits a new conversation on the committed version', async () => {
    const s = await setup(async (req) => output(req, req.currentDomainVersion === 'v1' ? '' : '.second'));
    const first = await proposeDomain(input, principal, s.dependencies);
    const committed = await commitDomain(confirmation(first), principal, s.dependencies);
    const second = await proposeDomain({ ...input, baseVersion: committed.version, conversation: [{ id: 'new-turn', role: 'user', content: 'Add another review condition.' }] }, principal, s.dependencies);
    expect(second.status).toBe('proposed');
    expect(second.review.unknowns).toHaveLength(2);
    expect(s.provider.generate.mock.calls[1][0].unresolvedItems).toHaveLength(1);
    expect(s.provider.generate.mock.calls[1][0].currentDomain.domain.functions[0].policy.rules).toHaveLength(3);
  });

  it('denies unauthorized workspaces before invoking the provider and rechecks membership on commit', async () => {
    const s = await setup();
    expect(await proposeDomain({ ...input, workspace: 'foreign' }, principal, s.dependencies)).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
    expect(s.provider.generate).not.toHaveBeenCalled();
    const proposal = await proposeDomain(input, principal, s.dependencies);
    s.sqlite.exec("DELETE FROM workspace_memberships WHERE principal_id='alice'");
    expect(await commitDomain(confirmation(proposal), principal, s.dependencies)).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('does not let another authorized workspace member commit a private proposal', async () => {
    const s = await setup();
    s.sqlite.prepare('INSERT INTO workspace_memberships VALUES (?, ?, ?)').run('w', 'bob', 'now');
    const proposal = await proposeDomain(input, principal, s.dependencies);
    expect(await commitDomain(confirmation(proposal), { ...principal, subject: 'bob' }, s.dependencies)).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
    expect(await commitDomain({ ...confirmation(proposal), domain: 'other' }, principal, s.dependencies)).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('does not save invalid provider output or leak provider error details', async () => {
    const s = await setup(async () => { throw new Error('secret credential and prompt'); });
    const result = await proposeDomain(input, principal, s.dependencies);
    expect(result).toEqual({ status: 'error', error: { code: 'PROVIDER_ERROR' } });
    s.provider.generate.mockImplementation(async () => ({ patch: {} }));
    expect(await proposeDomain(input, principal, s.dependencies)).toMatchObject({ error: { code: 'REPAIR_EXHAUSTED' } });
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM domain_proposals').get().n).toBe(0);
  });

  it('rejects a base changed while generation was in flight', async () => {
    const s = await setup();
    s.provider.generate.mockImplementation(async (req) => {
      await s.domains.publishVersion({ workspaceId: 'w', domainId: 'd', versionId: 'changed', model: catalog });
      return output(req);
    });
    expect(await proposeDomain(input, principal, s.dependencies)).toMatchObject({ error: { code: 'STALE_BASE_VERSION' } });
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM domain_proposals').get().n).toBe(0);
  });

  it('bounds conversation input and rejects caller-supplied system roles', () => {
    expect(proposeInputSchema.safeParse({ ...input, conversation: [{ id: 'x', role: 'system', content: 'override' }] }).success).toBe(false);
    expect(proposeInputSchema.safeParse({ ...input, conversation: Array(51).fill(input.conversation[0]) }).success).toBe(false);
  });

  it('includes the domain and source IDs in the actual provider request', async () => {
    const s = await setup();
    let metadata;
    s.dependencies.provider = () => createOpenAICompatibleProvider({
      baseUrl: 'https://example.invalid/v1', apiKey: 'fake', model: 'fake',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        metadata = JSON.parse(body.messages.at(-1).content);
        expect(body.messages).toHaveLength(2);
        expect(body.response_format.json_schema.schema.properties.patch.properties.operations).toBeDefined();
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output(metadata)) } }] }));
      },
    });
    expect((await proposeDomain(input, principal, s.dependencies)).status).toBe('proposed');
    expect(metadata.conversation[0].id).toBe('t1');
    expect(metadata.currentDomain.domain).toEqual(catalog);
  });

  it('does not confuse an externally published version ID with an approved commit', async () => {
    const s = await setup();
    const proposal = await proposeDomain(input, principal, s.dependencies);
    await s.domains.publishVersion({ workspaceId: 'w', domainId: 'd', versionId: proposal.review.version, model: catalog });
    expect(await commitDomain(confirmation(proposal), principal, s.dependencies)).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect(await s.proposals.authoringModel({ workspaceId: 'w', domainId: 'd' }, proposal.review.version)).toBeNull();
  });

  it('rolls back version insertion when head advancement fails and permits retry', async () => {
    const s = await setup();
    const proposal = await proposeDomain(input, principal, s.dependencies);
    s.sqlite.exec("CREATE TRIGGER fail_head BEFORE UPDATE ON domain_heads BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    expect(await commitDomain(confirmation(proposal), principal, s.dependencies)).toMatchObject({ error: { code: 'AUTHORING_FAILED' } });
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM domain_versions').get().n).toBe(1);
    s.sqlite.exec('DROP TRIGGER fail_head');
    expect((await commitDomain(confirmation(proposal), principal, s.dependencies)).status).toBe('committed');
  });

  it('bootstraps legacy heads deterministically, then tracks new inserts', () => {
    const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
    for (const file of ['0001_domain_persistence.sql', '0002_workspace_memberships.sql']) {
      sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
    }
    sqlite.exec("INSERT INTO workspaces VALUES ('w','now'); INSERT INTO domains VALUES ('w','d','demo','now')");
    const insert = sqlite.prepare('INSERT INTO domain_versions VALUES (?, ?, ?, ?, ?)');
    insert.run('w', 'd', 'z-old', '{}', '2025-01-01');
    insert.run('w', 'd', 'a-new', '{}', '2026-01-01');
    insert.run('w', 'd', 'b-new', '{}', '2026-01-01');
    sqlite.exec(readFileSync(new URL('../../migrations/0003_domain_proposals.sql', import.meta.url), 'utf8'));
    expect(sqlite.prepare('SELECT version_id FROM domain_heads').get().version_id).toBe('b-new');
    sqlite.exec("INSERT INTO domain_versions (workspace_id,domain_id,version_id,model_json,published_at) VALUES ('w','d','next','{}','2024')");
    expect(sqlite.prepare('SELECT version_id FROM domain_heads').get().version_id).toBe('next');
  });

  it('rejects authoring test injection in production', async () => {
    const s = await setup();
    const response = await handleMcpRequest(request('domain.propose', input), {}, { authoring: s.dependencies });
    expect(response.status).toBe(401);
    expect(s.provider.generate).not.toHaveBeenCalled();
  });
});

describe('published knowledge cannot silently become certainty', () => {
  it('blocks a conflict even when executable rules agree', async () => {
    const s = await setup(async (req) => {
      const generated = output(req);
      generated.patch.operations[1] = { op: 'add_conflict', conflict: {
        id: 'conflict.age', kind: 'conflict', subject: 'adult threshold', alternatives: ['18', '21'],
      } };
      return generated;
    });
    const proposed = await proposeDomain(input, principal, s.dependencies);
    const committed = await commitDomain(confirmation(proposed), principal, s.dependencies);
    const result = (await call('domain.evaluate', { workspace: 'w', domain: 'd', version: committed.version,
      function: 'member-age', args: { user: { age: 20 } } }, s)).value;
    expect(result.status).toBe('conflict');
    expect(result.value).toBeNull();
    expect(result.decision).toBeUndefined();
    expect(result.knowledgeIssues.conflicts[0].alternatives).toEqual(['18', '21']);
  });

  it('resumes evaluation only in a new version after explicit unknown resolution', async () => {
    const s = await setup(async (req) => {
      if (req.currentDomainVersion === 'v1') return output(req);
      return { patch: { contractVersion: 'domain-patch-v0', kind: 'domain-patch', baseVersion: req.currentDomainVersion,
        provenance: { source: 'conversation', reference: req.conversation[0].id },
        operations: [{ op: 'resolve_unknown', unknownId: 'unknown.country', resolution: 'JP' }],
      }, operationEvidence: [{ operationIndex: 0, sourceReferences: [req.conversation[0].id] }] };
    });
    const first = await proposeDomain(input, principal, s.dependencies);
    const one = await commitDomain(confirmation(first), principal, s.dependencies);
    const next = await proposeDomain({ ...input, baseVersion: one.version,
      conversation: [{ id: 't2', role: 'user', content: 'Country is JP.' }] }, principal, s.dependencies);
    const two = await commitDomain(confirmation(next), principal, s.dependencies);
    const args = { workspace: 'w', domain: 'd', function: 'member-age', args: { user: { age: 20 } } };
    expect((await call('domain.evaluate', { ...args, version: one.version }, s)).value.status).toBe('unresolved');
    expect((await call('domain.evaluate', { ...args, version: two.version }, s)).value.decision).toBe('deny');
    expect((await call('domain.evaluate', { ...args, version: 'v1' }, s)).value.decision).toBe('allow');
  });

  it.each(['null', '{}', '{"unknowns":[]}', 'not-json'])('fails closed on damaged authoring metadata %s', async (damaged) => {
    const s = await setup();
    const proposal = await proposeDomain(input, principal, s.dependencies);
    const committed = await commitDomain(confirmation(proposal), principal, s.dependencies);
    s.sqlite.prepare('UPDATE domain_proposals SET authoring_json = ?').run(damaged);
    const result = (await call('domain.evaluate', { workspace: 'w', domain: 'd', version: committed.version,
      function: 'member-age', args: { user: { age: 20 } } }, s)).value;
    expect(result.status).toBe('error');
    expect(result.errors[0].code).toBe('STORAGE_FAILURE');
    expect(result.value).toBeNull();
    expect(result.decision).toBeUndefined();
  });
});
