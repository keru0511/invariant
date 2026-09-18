import { describe, expect, it } from 'vitest';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import {
  createDomainRepository,
  DomainRepositoryError,
  type D1DatabaseLike,
} from './domain-repository';
import { FakeD1Database } from './fake-d1';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function repository(db: FakeD1Database) {
  return createDomainRepository(db as unknown as D1DatabaseLike, {
    now: () => '2026-09-18T00:00:00.000Z',
  });
}

function expectRepositoryError(error: unknown, code: DomainRepositoryError['code']): void {
  expect(error).toBeInstanceOf(DomainRepositoryError);
  expect((error as DomainRepositoryError).code).toBe(code);
}

describe('D1 domain persistence', () => {
  it('stores and explicitly loads multiple workspace/domain/version combinations', async () => {
    const db = new FakeD1Database();
    const repo = repository(db);
    const workspaceAModel = clone(functionCatalog);
    const workspaceBModel = clone(functionCatalog);
    workspaceBModel.functions[0].description = 'workspace B';

    await repo.publishVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v1', model: workspaceAModel });
    await repo.publishVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v2', model: workspaceAModel });
    await repo.publishVersion({ workspaceId: 'workspace-a', domainId: 'billing', versionId: 'v1', model: workspaceAModel });
    await repo.publishVersion({ workspaceId: 'workspace-b', domainId: 'orders', versionId: 'v1', model: workspaceBModel });

    expect((await repo.loadVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v1' }))?.model).toEqual(workspaceAModel);
    expect((await repo.loadVersion({ workspaceId: 'workspace-a', domainId: 'billing', versionId: 'v1' }))?.model).toEqual(workspaceAModel);
    expect((await repo.loadVersion({ workspaceId: 'workspace-b', domainId: 'orders', versionId: 'v1' }))?.model).toEqual(workspaceBModel);
    expect(await repo.loadVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'missing' })).toBeNull();
  });

  it('keeps v1 unchanged after v2 is published', async () => {
    const db = new FakeD1Database();
    const repo = repository(db);
    const v1 = clone(functionCatalog);
    const v2 = clone(functionCatalog);
    v2.functions[0].description = 'updated in v2';

    await repo.publishVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v1', model: v1 });
    await repo.publishVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v2', model: v2 });

    expect((await repo.loadVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v1' }))?.model).toEqual(v1);
    expect((await repo.loadVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v2' }))?.model).toEqual(v2);
  });

  it('does not persist invalid models', async () => {
    const db = new FakeD1Database();
    const repo = repository(db);
    const invalid = clone(functionCatalog) as Record<string, unknown>;
    delete invalid.kind;

    await expect(repo.publishVersion({
      workspaceId: 'workspace-a',
      domainId: 'orders',
      versionId: 'v1',
      model: invalid,
    })).rejects.toMatchObject({ code: 'INVALID_DOMAIN' });

    expect(db.count('workspaces')).toBe(0);
    expect(db.count('domains')).toBe(0);
    expect(db.count('domain_versions')).toBe(0);
  });

  it('rejects duplicate version IDs without overwriting the original', async () => {
    const db = new FakeD1Database();
    const repo = repository(db);
    const original = clone(functionCatalog);
    const attemptedOverwrite = clone(functionCatalog);
    attemptedOverwrite.functions[0].description = 'must not replace v1';

    await repo.publishVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v1', model: original });
    await expect(repo.publishVersion({
      workspaceId: 'workspace-a',
      domainId: 'orders',
      versionId: 'v1',
      model: attemptedOverwrite,
    })).rejects.toSatisfy((error: unknown) => {
      expectRepositoryError(error, 'DUPLICATE_VERSION');
      return true;
    });

    expect((await repo.loadVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v1' }))?.model).toEqual(original);
    expect(db.count('domain_versions')).toBe(1);
  });

  it('isolates lookups by workspace', async () => {
    const db = new FakeD1Database();
    const repo = repository(db);
    await repo.publishVersion({ workspaceId: 'workspace-a', domainId: 'orders', versionId: 'v1', model: functionCatalog });

    expect(await repo.loadVersion({ workspaceId: 'workspace-b', domainId: 'orders', versionId: 'v1' })).toBeNull();
  });

  it('rolls back parent rows and versions when an atomic publish batch fails', async () => {
    const db = new FakeD1Database();
    const repo = repository(db);
    db.failNextBatchAfter(1);

    await expect(repo.publishVersion({
      workspaceId: 'workspace-failed',
      domainId: 'orders',
      versionId: 'v1',
      model: functionCatalog,
    })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });

    expect(db.count('workspaces')).toBe(0);
    expect(db.count('domains')).toBe(0);
    expect(db.count('domain_versions')).toBe(0);
  });
});
