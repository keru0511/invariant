import { describe, expect, it } from 'vitest';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import { parseDomain } from '../domain';
import {
  AuthWorkspaceRepositoryAdapter,
  D1WorkspaceMembershipRepository,
  PUBLIC_RESOURCE_NOT_FOUND,
  WorkspaceAccessError,
  type DomainRepositoryPort,
} from './workspace-access';
import {
  createDomainRepository,
  type D1DatabaseLike,
  type DomainSearchCandidate,
  type DomainVersionRecord,
} from './domain-repository';
import { FakeD1Database } from './fake-d1';
import type { AccessPrincipal } from '../worker/access-auth';

const PRINCIPAL_A: AccessPrincipal = {
  subject: 'principal-a',
  issuer: 'https://test.cloudflareaccess.com',
  audience: 'test-audience',
  expiresAt: 1_900_000_000,
};

const PRINCIPAL_B: AccessPrincipal = {
  ...PRINCIPAL_A,
  subject: 'principal-b',
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validModel(): DomainVersionRecord['model'] {
  const parsed = parseDomain(functionCatalog);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function createAdapter(db: FakeD1Database): AuthWorkspaceRepositoryAdapter {
  const domainRepository = createDomainRepository(db as unknown as D1DatabaseLike, {
    now: () => '2026-09-18T00:00:00.000Z',
  });
  return new AuthWorkspaceRepositoryAdapter(
    new D1WorkspaceMembershipRepository(db as unknown as D1DatabaseLike),
    domainRepository,
  );
}

function expectResourceNotFound(error: unknown): void {
  expect(error).toBeInstanceOf(WorkspaceAccessError);
  expect((error as WorkspaceAccessError).code).toBe(PUBLIC_RESOURCE_NOT_FOUND);
  expect((error as Error).message).toBe('Resource not found.');
}

describe('authenticated workspace domain access', () => {
  it('AC: authorized workspace access succeeds', async () => {
    const db = new FakeD1Database();
    db.seedWorkspaceMembership('workspace-a', PRINCIPAL_A.subject);
    const workspace = await createAdapter(db).forPrincipal(PRINCIPAL_A, 'workspace-a');

    const record = await workspace.publishVersion({
      domainId: 'orders',
      versionId: 'v1',
      model: functionCatalog,
    });

    expect(record.workspaceId).toBe('workspace-a');
    expect((await workspace.loadVersion({ domainId: 'orders', versionId: 'v1' })).model)
      .toEqual(functionCatalog);
  });

  it('AC: foreign workspace access fails before the domain repository is called', async () => {
    const db = new FakeD1Database();
    db.seedWorkspaceMembership('workspace-a', PRINCIPAL_A.subject);
    db.seedWorkspaceMembership('workspace-b', PRINCIPAL_B.subject);
    const calls: string[] = [];
    const domainRepository: DomainRepositoryPort = {
      async createDomain(input) {
        calls.push(`create:${input.workspaceId}`);
      },
      async publishVersion(input): Promise<DomainVersionRecord> {
        calls.push(`publish:${input.workspaceId}`);
        throw new Error('should not be called');
      },
      async loadVersion(input) {
        calls.push(`load:${input.workspaceId}`);
        return null;
      },
      async search(input): Promise<readonly DomainSearchCandidate[]> {
        calls.push(`search:${input.workspaceId}`);
        return [];
      },
    };
    const adapter = new AuthWorkspaceRepositoryAdapter(
      new D1WorkspaceMembershipRepository(db as unknown as D1DatabaseLike),
      domainRepository,
    );

    await expect(adapter.forPrincipal(PRINCIPAL_A, 'workspace-b')).rejects.toSatisfy((error: unknown) => {
      expectResourceNotFound(error);
      return true;
    });
    expect(calls).toEqual([]);
  });

  it('AC: same domain/version IDs remain isolated across workspaces', async () => {
    const db = new FakeD1Database();
    db.seedWorkspaceMembership('workspace-a', PRINCIPAL_A.subject);
    db.seedWorkspaceMembership('workspace-b', PRINCIPAL_B.subject);
    const adapter = createAdapter(db);
    const workspaceA = await adapter.forPrincipal(PRINCIPAL_A, 'workspace-a');
    const workspaceB = await adapter.forPrincipal(PRINCIPAL_B, 'workspace-b');
    const workspaceBModel = clone(functionCatalog);
    workspaceBModel.functions[0].description = 'workspace B';

    await workspaceA.publishVersion({ domainId: 'orders', versionId: 'v1', model: functionCatalog });
    await workspaceB.publishVersion({ domainId: 'orders', versionId: 'v1', model: workspaceBModel });

    expect((await workspaceA.loadVersion({ domainId: 'orders', versionId: 'v1' })).model)
      .toEqual(functionCatalog);
    expect((await workspaceB.loadVersion({ domainId: 'orders', versionId: 'v1' })).model)
      .toEqual(workspaceBModel);
  });

  it('AC: foreign-existing and nonexistent resources expose the same public error category', async () => {
    const db = new FakeD1Database();
    db.seedWorkspaceMembership('workspace-a', PRINCIPAL_A.subject);
    db.seedWorkspaceMembership('workspace-b', PRINCIPAL_B.subject);
    const adapter = createAdapter(db);
    const workspaceA = await adapter.forPrincipal(PRINCIPAL_A, 'workspace-a');
    const workspaceB = await adapter.forPrincipal(PRINCIPAL_B, 'workspace-b');
    await workspaceB.publishVersion({ domainId: 'orders', versionId: 'v1', model: functionCatalog });

    const foreign = await adapter.forPrincipal(PRINCIPAL_A, 'workspace-b').catch((error: unknown) => error);
    const nonexistent = await workspaceA.loadVersion({ domainId: 'orders', versionId: 'missing' })
      .catch((error: unknown) => error);

    expect(foreign).toBeInstanceOf(WorkspaceAccessError);
    expect(nonexistent).toBeInstanceOf(WorkspaceAccessError);
    expect((foreign as WorkspaceAccessError).code).toBe((nonexistent as WorkspaceAccessError).code);
    expect((foreign as Error).message).toBe((nonexistent as Error).message);
  });

  it('AC: every domain repository call is workspace-scoped', async () => {
    const db = new FakeD1Database();
    db.seedWorkspaceMembership('workspace-a', PRINCIPAL_A.subject);
    const calls: Array<{ operation: string; workspaceId: unknown }> = [];
    const domainRepository: DomainRepositoryPort = {
      async createDomain(input) {
        calls.push({ operation: 'createDomain', workspaceId: input.workspaceId });
      },
      async publishVersion(input): Promise<DomainVersionRecord> {
        calls.push({ operation: 'publishVersion', workspaceId: input.workspaceId });
        return {
          workspaceId: input.workspaceId,
          domainId: input.domainId,
          versionId: input.versionId,
          model: validModel(),
          publishedAt: '2026-09-18T00:00:00.000Z',
        };
      },
      async loadVersion(input) {
        calls.push({ operation: 'loadVersion', workspaceId: input.workspaceId });
        return {
          workspaceId: input.workspaceId,
          domainId: input.domainId,
          versionId: input.versionId,
          model: validModel(),
          publishedAt: '2026-09-18T00:00:00.000Z',
        };
      },
      async search(input) {
        calls.push({ operation: 'search', workspaceId: input.workspaceId });
        return [];
      },
    };
    const adapter = new AuthWorkspaceRepositoryAdapter(
      new D1WorkspaceMembershipRepository(db as unknown as D1DatabaseLike),
      domainRepository,
    );
    const workspace = await adapter.forPrincipal(PRINCIPAL_A, 'workspace-a');

    await workspace.createDomain({ domainId: 'orders', name: 'Orders' });
    await workspace.publishVersion({ domainId: 'orders', versionId: 'v1', model: functionCatalog });
    await workspace.loadVersion({ domainId: 'orders', versionId: 'v1' });
    await workspace.search({ query: 'orders', limit: 10 });

    expect(calls).toEqual([
      { operation: 'createDomain', workspaceId: 'workspace-a' },
      { operation: 'publishVersion', workspaceId: 'workspace-a' },
      { operation: 'loadVersion', workspaceId: 'workspace-a' },
      { operation: 'search', workspaceId: 'workspace-a' },
    ]);
    expect(calls.every((call) => call.workspaceId === 'workspace-a')).toBe(true);
  });

  it('AC: scoped search filters candidates to the authorized workspace', async () => {
    const db = new FakeD1Database();
    db.seedWorkspaceMembership('workspace-a', PRINCIPAL_A.subject);
    const domainRepository: DomainRepositoryPort = {
      async createDomain() {},
      async publishVersion(input): Promise<DomainVersionRecord> {
        return {
          workspaceId: input.workspaceId,
          domainId: input.domainId,
          versionId: input.versionId,
          model: validModel(),
          publishedAt: '2026-09-18T00:00:00.000Z',
        };
      },
      async loadVersion(input) {
        return {
          workspaceId: input.workspaceId,
          domainId: input.domainId,
          versionId: input.versionId,
          model: validModel(),
          publishedAt: '2026-09-18T00:00:00.000Z',
        };
      },
      async search() {
        return [
          {
            workspaceId: 'workspace-a',
            domainId: 'orders',
            domainName: 'Orders',
            versionId: 'v1',
            functionId: 'function.orders.refund',
            functionName: 'refund',
            description: 'local',
          },
          {
            workspaceId: 'workspace-b',
            domainId: 'orders',
            domainName: 'Orders',
            versionId: 'v1',
            functionId: 'function.orders.refund',
            functionName: 'refund',
            description: 'foreign',
          },
        ];
      },
    };
    const adapter = new AuthWorkspaceRepositoryAdapter(
      new D1WorkspaceMembershipRepository(db as unknown as D1DatabaseLike),
      domainRepository,
    );
    const workspace = await adapter.forPrincipal(PRINCIPAL_A, 'workspace-a');

    await expect(workspace.search({ query: 'refund', limit: 10 })).resolves.toEqual([
      {
        domainId: 'orders',
        domainName: 'Orders',
        versionId: 'v1',
        functionId: 'function.orders.refund',
        functionName: 'refund',
        description: 'local',
      },
    ]);
  });
});
