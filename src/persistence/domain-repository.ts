import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  parseDomain,
  type DomainCatalog,
  type DomainParseError,
} from '../domain';

export type D1DatabaseLike = Pick<D1Database, 'prepare' | 'batch'>;

export interface CreateWorkspaceInput {
  readonly workspaceId: string;
}

export interface CreateDomainInput {
  readonly workspaceId: string;
  readonly domainId: string;
  readonly name: string;
}

export interface PublishDomainVersionInput {
  readonly workspaceId: string;
  readonly domainId: string;
  readonly versionId: string;
  readonly model: unknown;
}

export interface LoadDomainVersionInput {
  readonly workspaceId: string;
  readonly domainId: string;
  readonly versionId: string;
}

export interface SearchDomainInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly limit: number;
}

export interface DomainVersionRecord {
  readonly workspaceId: string;
  readonly domainId: string;
  readonly versionId: string;
  readonly model: DomainCatalog;
  readonly publishedAt: string;
}

export interface DomainSearchCandidate {
  readonly workspaceId: string;
  readonly domainId: string;
  readonly domainName: string;
  readonly versionId: string;
  readonly functionId: string;
  readonly functionName: string;
  readonly description: string;
}

export interface DomainSearchMatch {
  readonly domainId: string;
  readonly domainName: string;
  readonly versionId: string;
  readonly functionId: string;
  readonly functionName: string;
  readonly description: string;
}

export const DOMAIN_SEARCH_MAX_LIMIT = 100 as const;

export class DomainRepositoryError extends Error {
  readonly name = 'DomainRepositoryError';
  readonly code:
    | 'INVALID_IDENTIFIER'
    | 'INVALID_QUERY'
    | 'INVALID_LIMIT'
    | 'INVALID_DOMAIN'
    | 'DUPLICATE_VERSION'
    | 'CORRUPT_VERSION'
    | 'STORAGE_FAILURE';
  readonly errors?: readonly DomainParseError[];

  constructor(
    code: DomainRepositoryError['code'],
    message: string,
    errors?: readonly DomainParseError[],
  ) {
    super(message);
    this.code = code;
    this.errors = errors;
  }
}

export interface DomainRepositoryOptions {
  readonly now?: () => string;
}

interface StoredVersionRow {
  readonly workspace_id: string;
  readonly domain_id: string;
  readonly version_id: string;
  readonly model_json: string;
  readonly published_at: string;
}

interface StoredSearchRow extends StoredVersionRow {
  readonly domain_name: string;
}

const INSERT_WORKSPACE = `
  INSERT INTO workspaces (id, created_at)
  VALUES (?, ?)
  ON CONFLICT (id) DO NOTHING
`;

const INSERT_DOMAIN = `
  INSERT INTO domains (workspace_id, id, name, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (workspace_id, id) DO NOTHING
`;

const SELECT_VERSION = `
  SELECT workspace_id, domain_id, version_id, model_json, published_at
  FROM domain_versions
  WHERE workspace_id = ? AND domain_id = ? AND version_id = ?
`;

const SELECT_SEARCH_VERSIONS = `
  SELECT
    d.workspace_id,
    d.id AS domain_id,
    d.name AS domain_name,
    v.version_id,
    v.model_json,
    v.published_at
  FROM domains AS d
  INNER JOIN domain_versions AS v
    ON v.workspace_id = d.workspace_id AND v.domain_id = d.id
  WHERE d.workspace_id = ?
`;

const INSERT_VERSION = `
  INSERT INTO domain_versions
    (workspace_id, domain_id, version_id, model_json, published_at)
  VALUES (?, ?, ?, ?, ?)
`;

function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new DomainRepositoryError('INVALID_IDENTIFIER', `${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function statement(db: D1DatabaseLike, sql: string, ...values: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...values);
}

function isDuplicateFailure(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

function canonicalVersion(row: StoredVersionRow): DomainVersionRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.model_json) as unknown;
  } catch {
    throw new DomainRepositoryError('CORRUPT_VERSION', 'Stored domain version is not valid JSON.');
  }
  const parsed = parseDomain(decoded);
  if (!parsed.ok) {
    throw new DomainRepositoryError(
      'CORRUPT_VERSION',
      `Stored domain version failed validation at ${parsed.error.path}.`,
      parsed.errors,
    );
  }
  return Object.freeze({
    workspaceId: row.workspace_id,
    domainId: row.domain_id,
    versionId: row.version_id,
    model: parsed.value,
    publishedAt: row.published_at,
  });
}

function compareText(left: string, right: string): number {
  const leftFolded = left.toLowerCase();
  const rightFolded = right.toLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareCandidates(left: DomainSearchCandidate, right: DomainSearchCandidate): number {
  return compareText(left.domainName, right.domainName)
    || compareText(left.domainId, right.domainId)
    || compareText(left.functionName, right.functionName)
    || compareText(left.functionId, right.functionId)
    || compareText(left.versionId, right.versionId)
    || compareText(left.description, right.description);
}

function searchQuery(value: string): string {
  if (typeof value !== 'string') {
    throw new DomainRepositoryError('INVALID_QUERY', 'query must be a string.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DomainRepositoryError('INVALID_QUERY', 'query must be a non-empty trimmed string.');
  }
  return trimmed;
}

function searchLimit(value: number): number {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || value > DOMAIN_SEARCH_MAX_LIMIT
  ) {
    throw new DomainRepositoryError(
      'INVALID_LIMIT',
      `limit must be an integer between 1 and ${DOMAIN_SEARCH_MAX_LIMIT}.`,
    );
  }
  return value;
}

export class D1DomainRepository {
  private readonly now: () => string;

  constructor(
    private readonly db: D1DatabaseLike,
    options: DomainRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    const workspaceId = identifier(input.workspaceId, 'workspaceId');
    await statement(this.db, INSERT_WORKSPACE, workspaceId, this.now()).run();
  }

  async createDomain(input: CreateDomainInput): Promise<void> {
    const workspaceId = identifier(input.workspaceId, 'workspaceId');
    const domainId = identifier(input.domainId, 'domainId');
    const name = identifier(input.name, 'name');
    const now = this.now();
    await this.db.batch([
      statement(this.db, INSERT_WORKSPACE, workspaceId, now),
      statement(this.db, INSERT_DOMAIN, workspaceId, domainId, name, now),
    ]);
  }

  async publishVersion(input: PublishDomainVersionInput): Promise<DomainVersionRecord> {
    const workspaceId = identifier(input.workspaceId, 'workspaceId');
    const domainId = identifier(input.domainId, 'domainId');
    const versionId = identifier(input.versionId, 'versionId');
    const parsed = parseDomain(input.model);
    if (!parsed.ok) {
      throw new DomainRepositoryError(
        'INVALID_DOMAIN',
        `Domain model failed validation at ${parsed.error.path}.`,
        parsed.errors,
      );
    }

    const existing = await statement(
      this.db,
      SELECT_VERSION,
      workspaceId,
      domainId,
      versionId,
    ).first<StoredVersionRow>();
    if (existing !== null) {
      throw new DomainRepositoryError(
        'DUPLICATE_VERSION',
        `Version '${versionId}' already exists for domain '${domainId}'.`,
      );
    }

    const publishedAt = this.now();
    const modelJson = JSON.stringify(parsed.value);
    try {
      // D1 batch is atomic: parent creation and version insertion either all
      // commit or none do. The plain INSERT intentionally cannot overwrite.
      await this.db.batch([
        statement(this.db, INSERT_WORKSPACE, workspaceId, publishedAt),
        statement(this.db, INSERT_DOMAIN, workspaceId, domainId, domainId, publishedAt),
        statement(
          this.db,
          INSERT_VERSION,
          workspaceId,
          domainId,
          versionId,
          modelJson,
          publishedAt,
        ),
      ]);
    } catch (error) {
      if (isDuplicateFailure(error)) {
        throw new DomainRepositoryError(
          'DUPLICATE_VERSION',
          `Version '${versionId}' already exists for domain '${domainId}'.`,
        );
      }
      throw new DomainRepositoryError(
        'STORAGE_FAILURE',
        error instanceof Error ? error.message : 'D1 publish failed.',
      );
    }

    return Object.freeze({
      workspaceId,
      domainId,
      versionId,
      model: parsed.value,
      publishedAt,
    });
  }

  async loadVersion(input: LoadDomainVersionInput): Promise<DomainVersionRecord | null> {
    const workspaceId = identifier(input.workspaceId, 'workspaceId');
    const domainId = identifier(input.domainId, 'domainId');
    const versionId = identifier(input.versionId, 'versionId');
    const row = await statement(
      this.db,
      SELECT_VERSION,
      workspaceId,
      domainId,
      versionId,
    ).first<StoredVersionRow>();
    return row === null ? null : canonicalVersion(row);
  }

  async search(input: SearchDomainInput): Promise<readonly DomainSearchCandidate[]> {
    const workspaceId = identifier(input.workspaceId, 'workspaceId');
    const query = searchQuery(input.query).toLowerCase();
    const limit = searchLimit(input.limit);
    const rows = await statement(this.db, SELECT_SEARCH_VERSIONS, workspaceId)
      .all<StoredSearchRow>();
    const candidates: DomainSearchCandidate[] = [];

    for (const row of rows.results) {
      // Keep the scope defensive even if a non-D1 test double returns rows it
      // should not have returned for the bound workspace parameter.
      if (row.workspace_id !== workspaceId) continue;
      const version = canonicalVersion(row);
      const domainMatches = row.domain_name.toLowerCase().includes(query);

      for (const domainFunction of version.model.functions) {
        if (!domainMatches
          && !domainFunction.name.toLowerCase().includes(query)
          && !domainFunction.description.toLowerCase().includes(query)) {
          continue;
        }
        candidates.push(Object.freeze({
          workspaceId: row.workspace_id,
          domainId: row.domain_id,
          domainName: row.domain_name,
          versionId: row.version_id,
          functionId: domainFunction.id,
          functionName: domainFunction.name,
          description: domainFunction.description,
        }));
      }
    }

    candidates.sort(compareCandidates);
    return Object.freeze(candidates.slice(0, limit));
  }
}

export function createDomainRepository(
  db: D1DatabaseLike,
  options?: DomainRepositoryOptions,
): D1DomainRepository {
  return new D1DomainRepository(db, options);
}
