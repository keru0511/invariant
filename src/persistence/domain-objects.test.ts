import type { D1DatabaseLike } from './domain-repository';
import { expect, it } from 'vitest';
import catalog from '../../fixtures/domain-v0/functions.json';
import { packCatalog, packModel, objectStatements } from './domain-objects';

it('identifies canonical content independently of object key insertion order', async () => {
  const one = await packCatalog(catalog);
  const two = await packCatalog({ functions: catalog.functions, kind: catalog.kind, contractVersion: catalog.contractVersion });
  expect(two.hash).toBe(one.hash);
  expect(two.catalogPointer).toBe(one.catalogPointer);
});

it('shares identical model content across history IDs without losing knowledge metadata', async () => {
  const model = { contractVersion: 'domain-v0', kind: 'domain-model', version: 'v1', domain: catalog,
    types: [], examples: [], unknowns: [{ id: 'u', kind: 'unknown', subject: 'country', description: 'Not known' }], conflicts: [] };
  const first = await packModel(model);
  const second = await packModel({ ...model, version: 'v2' });
  expect(second.hash).toBe(first.hash);
  expect(second.objects).toEqual(first.objects);
  const resolved = await packModel({ ...model, version: 'v3', unknowns: [] });
  expect(resolved.catalogPointer).toBe(first.catalogPointer);
  expect(resolved.hash).not.toBe(first.hash);
});

it('bounds write statement parameters below the D1 limit', () => {
  const counts: number[] = [];
  const db = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => { counts.push(values.length); return {}; } }) } as unknown as D1DatabaseLike;
  objectStatements(db, { workspaceId: 'w', domainId: 'd' }, Array.from({ length: 61 }, () => ({ hash: '0'.repeat(64), payload: '{}' })));
  expect(counts).toEqual([96, 96, 52]);
});
