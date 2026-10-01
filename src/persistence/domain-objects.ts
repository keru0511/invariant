import type { D1DatabaseLike } from './domain-repository';
import { parseDomain, type DomainCatalog } from '../domain/runtime';
import { parseDomainModel, type DomainPatchModel } from '../domain/patch';
import { stableJsonStringify, parseJsonValue, type JsonValue } from '../domain/decision-context';

const FORMAT = 'invariant-object-v1';
const STORAGE = 'invariant-cas-v1';
const HASH = /^[a-f0-9]{64}$/;
export interface ObjectScope { readonly workspaceId: string; readonly domainId: string; }
export interface SnapshotPointer { readonly storage: typeof STORAGE; readonly kind: 'catalog' | 'model'; readonly hash: string; }
export interface StoredObject { readonly hash: string; readonly payload: string; }
export class SnapshotStorageError extends Error { constructor() { super('Invalid or missing content-addressed snapshot.'); } }
const bad = (): never => { throw new SnapshotStorageError(); };
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad();
}
function refs(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && HASH.test(item)) ? value : bad();
}
export async function contentHash(payload: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function snapshotPointer(value: unknown): SnapshotPointer | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('storage' in value)) return null;
  const record = value as Record<string, unknown>;
  if (record.storage !== STORAGE || !['catalog', 'model'].includes(String(record.kind))
    || typeof record.hash !== 'string' || !HASH.test(record.hash)
    || Object.keys(record).some((key) => !['storage', 'kind', 'hash'].includes(key))) return bad();
  return record as unknown as SnapshotPointer;
}
function pointer(kind: SnapshotPointer['kind'], hash: string): string { return JSON.stringify({ storage: STORAGE, kind, hash }); }

class Builder {
  readonly objects = new Map<string, StoredObject>();
  async add(kind: string, value: unknown): Promise<string> {
    const payload = stableJsonStringify({ format: FORMAT, kind, value } as JsonValue);
    const hash = await contentHash(payload);
    this.objects.set(hash, { hash, payload });
    return hash;
  }
  async catalog(domain: DomainCatalog): Promise<string> {
    const functions = [];
    for (const fn of domain.functions) {
      const rules = await Promise.all(fn.policy.rules.map((rule) => this.add('rule', rule)));
      const hash = await this.add('function', { ...fn, policy: { ...fn.policy, rules } });
      // The tree carries small search headers; the executable rule bodies are shared objects.
      functions.push({ hash, id: fn.id, name: fn.name, description: fn.description });
    }
    return this.add('catalog', { ...domain, functions });
  }
}
export async function packCatalog(value: unknown) {
  const parsed = parseDomain(value); if (!parsed.ok) return bad();
  const builder = new Builder(); const hash = await builder.catalog(parsed.value);
  return { hash, catalogPointer: pointer('catalog', hash), objects: [...builder.objects.values()] };
}
export async function packModel(value: unknown) {
  const parsed = parseDomainModel(value); if (!parsed.ok) return bad();
  const model = parsed.value;
  const builder = new Builder(); const catalogHash = await builder.catalog(model.domain);
  const { version: _version, domain: _domain, types, examples, unknowns, conflicts, ...header } = model;
  const hash = await builder.add('model', { ...header, domain: catalogHash,
    types: await Promise.all(types.map((item) => builder.add('type', item))),
    examples: await Promise.all(examples.map((item) => builder.add('example', item))),
    unknowns: await Promise.all(unknowns.map((item) => builder.add('unknown', item))),
    conflicts: await Promise.all(conflicts.map((item) => builder.add('conflict', item))),
  });
  return { hash, catalogPointer: pointer('catalog', catalogHash), modelPointer: pointer('model', hash), objects: [...builder.objects.values()] };
}
export function objectStatements(db: D1DatabaseLike, scope: ObjectScope, entries: readonly StoredObject[]) {
  const statements = [];
  // 24 rows x 4 values stays below D1's 100 bound-parameter limit.
  for (let start = 0; start < entries.length; start += 24) {
    const chunk = entries.slice(start, start + 24);
    statements.push(db.prepare(`INSERT INTO domain_objects (workspace_id, domain_id, object_hash, payload_json)
      VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')} ON CONFLICT (workspace_id, domain_id, object_hash) DO NOTHING`)
      .bind(...chunk.flatMap((entry) => [scope.workspaceId, scope.domainId, entry.hash, entry.payload])));
  }
  return statements;
}

export interface CatalogHeader { readonly hash: string; readonly id: string; readonly name: string; readonly description: string; }
function catalogHeaders(value: unknown): readonly CatalogHeader[] {
  const catalog = object(value);
  if (Object.keys(catalog).some((key) => !['contractVersion', 'kind', 'functions'].includes(key))) return bad();
  const ids = new Set<string>();
  if (catalog.contractVersion !== 'domain-v0' || catalog.kind !== 'function-catalog' || !Array.isArray(catalog.functions)) return bad();
  return Object.freeze(catalog.functions.map((entry) => {
    const item = object(entry);
    if (typeof item.hash !== 'string' || !HASH.test(item.hash) || typeof item.id !== 'string' || !item.id
      || typeof item.name !== 'string' || !item.name || typeof item.description !== 'string') return bad();
    if (item.id.trim() !== item.id || item.name.trim() !== item.name || ids.has(item.id)
      || Object.keys(item).some((key) => !['hash', 'id', 'name', 'description'].includes(key))) return bad();
    ids.add(item.id);
    return item as unknown as CatalogHeader;
  }));
}

/** Hashes are scoped by workspace/domain. Never resolve an object globally. */
export class DomainObjectReader {
  private readonly payloads = new Map<string, string>();
  private readonly verified = new Map<string, Record<string, unknown>>();
  constructor(private readonly db: D1DatabaseLike, private readonly scope: ObjectScope) {}
  private async prime(hashes: readonly string[]) {
    const missing = [...new Set(hashes)].filter((hash) => !this.payloads.has(hash));
    for (const hash of missing) if (!HASH.test(hash)) return bad();
    // Bound SQL parameter count and avoid one database query per rule.
    for (let start = 0; start < missing.length; start += 80) {
      const chunk = missing.slice(start, start + 80);
      const rows = await this.db.prepare(`SELECT object_hash, payload_json FROM domain_objects
        WHERE workspace_id = ? AND domain_id = ? AND object_hash IN (${chunk.map(() => '?').join(',')})`)
        .bind(this.scope.workspaceId, this.scope.domainId, ...chunk).all<{ object_hash: string; payload_json: string }>();
      for (const row of rows.results) if (chunk.includes(row.object_hash)) this.payloads.set(row.object_hash, row.payload_json);
      for (const hash of chunk) if (!this.payloads.has(hash)) return bad();
    }
  }
  private async get(hash: string, kind: string): Promise<unknown> {
    await this.prime([hash]);
    let envelope = this.verified.get(hash);
    if (!envelope) {
      const payload = this.payloads.get(hash)!;
      if (await contentHash(payload) !== hash) return bad();
      envelope = object(parseJsonValue(JSON.parse(payload), '$.object'));
      if (Object.keys(envelope).some((key) => !['format', 'kind', 'value'].includes(key))) return bad();
      if (envelope.format !== FORMAT) return bad();
      this.verified.set(hash, envelope);
    }
    if (envelope.kind !== kind) return bad();
    return envelope.value;
  }
  async catalogIndex(serialized: string, preloadedPayload?: string | null): Promise<readonly CatalogHeader[]> {
    const decoded: unknown = JSON.parse(serialized); const ref = snapshotPointer(decoded);
    if (!ref) {
      const parsed = parseDomain(decoded); if (!parsed.ok) return bad();
      return parsed.value.functions.map((fn) => ({ hash: '', id: fn.id, name: fn.name, description: fn.description }));
    }
    if (ref.kind !== 'catalog') return bad();
    if (preloadedPayload != null) this.payloads.set(ref.hash, preloadedPayload);
    return catalogHeaders(await this.get(ref.hash, 'catalog'));
  }
  private async catalog(hash: string): Promise<DomainCatalog> {
    const tree = object(await this.get(hash, 'catalog')); const headers = catalogHeaders(tree);
    await this.prime(headers.map((entry) => entry.hash));
    const functions = await Promise.all(headers.map(async (entry) => object(await this.get(entry.hash, 'function'))));
    const policies = functions.map((fn) => object(fn.policy));
    await this.prime(policies.flatMap((policy) => refs(policy.rules)));
    const expanded = await Promise.all(functions.map(async (fn, index) => {
      const header = headers[index];
      if (fn.id !== header.id || fn.name !== header.name || fn.description !== header.description) return bad();
      return { ...fn, policy: { ...policies[index], rules: await Promise.all(refs(policies[index].rules).map((ref) => this.get(ref, 'rule'))) } };
    }));
    const parsed = parseDomain({ ...tree, functions: expanded }); if (!parsed.ok) return bad();
    return parsed.value;
  }
  async readCatalog(serialized: string): Promise<DomainCatalog> {
    const decoded: unknown = JSON.parse(serialized); const ref = snapshotPointer(decoded);
    if (!ref) { const parsed = parseDomain(decoded); return parsed.ok ? parsed.value : bad(); }
    return ref.kind === 'catalog' ? this.catalog(ref.hash) : bad();
  }
  async readModel(serialized: string, version: string): Promise<DomainPatchModel> {
    const decoded: unknown = JSON.parse(serialized); const ref = snapshotPointer(decoded);
    if (!ref) {
      const parsed = parseDomainModel(decoded);
      return parsed.ok && parsed.value.version === version ? parsed.value : bad();
    }
    if (ref.kind !== 'model') return bad();
    const tree = object(await this.get(ref.hash, 'model'));
    if (Object.keys(tree).some((key) => !['contractVersion', 'kind', 'domain', 'types', 'examples', 'unknowns', 'conflicts', 'provenance'].includes(key))) return bad();
    if (typeof tree.domain !== 'string') return bad();
    const groups = ['types', 'examples', 'unknowns', 'conflicts'] as const;
    const kinds = ['type', 'example', 'unknown', 'conflict'];
    await this.prime(groups.flatMap((key) => refs(tree[key])));
    const collections = Object.fromEntries(await Promise.all(groups.map(async (key, index) =>
      [key, await Promise.all(refs(tree[key]).map((hash) => this.get(hash, kinds[index])))])));
    const parsed = parseDomainModel({ ...tree, ...collections, version, domain: await this.catalog(tree.domain) });
    return parsed.ok ? parsed.value : bad();
  }
}
