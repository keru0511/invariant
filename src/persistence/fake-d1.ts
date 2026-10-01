interface WorkspaceRow {
  readonly id: string;
  readonly created_at: string;
}

interface WorkspaceMembershipRow {
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly created_at: string;
}

interface DomainRow {
  readonly workspace_id: string;
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

interface ObjectRow { readonly workspace_id: string; readonly domain_id: string; readonly object_hash: string; readonly payload_json: string; }

interface VersionRow {
  readonly workspace_id: string;
  readonly domain_id: string;
  readonly version_id: string;
  readonly model_json: string;
  readonly published_at: string;
  readonly parent_version_id: string | null;
}

type Row = WorkspaceRow | WorkspaceMembershipRow | DomainRow | VersionRow | { readonly present: 1 };

function key(...values: string[]): string {
  return JSON.stringify(values);
}

function result<T>(rows: T[] = []): { readonly success: true; readonly results: T[]; readonly meta: Record<string, unknown> } {
  return {
    success: true,
    results: rows,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: rows.length,
      rows_written: 0,
      last_row_id: 0,
      changed_db: rows.length > 0,
      changes: rows.length,
    },
  };
}

class FakeD1PreparedStatement {
  constructor(
    private readonly database: FakeD1Database,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.database, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    this.database.record('first', this.sql, this.values);
    return this.database.first<T>(this.sql, this.values);
  }

  async all<T = Record<string, unknown>>() {
    this.database.record('all', this.sql, this.values);
    return this.database.all<T>(this.sql, this.values);
  }

  async run(): Promise<ReturnType<typeof result>> {
    this.database.record('run', this.sql, this.values);
    return this.database.run(this.sql, this.values);
  }
}

/**
 * Deterministic D1-shaped adapter for repository tests.
 * It models only the SQL emitted by D1DomainRepository and commits batches
 * against a cloned state, so a failed batch cannot leave partial rows.
 */
export class FakeD1Database {
  readonly calls: Array<{
    readonly operation: 'first' | 'all' | 'run';
    readonly sql: string;
    readonly values: readonly unknown[];
  }> = [];
  private workspaces = new Map<string, WorkspaceRow>();
  private memberships = new Map<string, WorkspaceMembershipRow>();
  private domains = new Map<string, DomainRow>();
  private versions = new Map<string, VersionRow>();
  private objects = new Map<string, ObjectRow>();
  private failAfterStatement: number | undefined;

  prepare(sql: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this, sql);
  }

  record(
    operation: 'first' | 'all' | 'run',
    sql: string,
    values: readonly unknown[],
  ): void {
    this.calls.push({ operation, sql, values: [...values] });
  }

  async batch(statements: readonly FakeD1PreparedStatement[]): Promise<readonly ReturnType<typeof result>[]> {
    const candidate = this.clone();
    const results: ReturnType<typeof result>[] = [];
    const failAfterStatement = this.failAfterStatement;
    this.failAfterStatement = undefined;
    for (const [index, statement] of statements.entries()) {
      results.push(await candidate.apply(statement.sql, statement.values));
      if (failAfterStatement === index) {
        throw new Error('injected D1 batch failure');
      }
    }
    this.copyFrom(candidate);
    return results;
  }

  /** Fail after applying this statement to the batch's private candidate state. */
  failNextBatchAfter(statementIndex: number): void {
    this.failAfterStatement = statementIndex;
  }

  count(table: 'workspaces' | 'domains' | 'domain_versions' | 'domain_objects'): number {
    if (table === 'workspaces') return this.workspaces.size;
    if (table === 'domains') return this.domains.size;
    if (table === 'domain_objects') return this.objects.size;
    return this.versions.size;
  }

  private clone(): FakeD1Database {
    const cloned = new FakeD1Database();
    cloned.workspaces = new Map(this.workspaces);
    cloned.memberships = new Map(this.memberships);
    cloned.domains = new Map(this.domains);
    cloned.versions = new Map(this.versions);
    cloned.objects = new Map(this.objects);
    return cloned;
  }

  private copyFrom(source: FakeD1Database): void {
    this.workspaces = source.workspaces;
    this.memberships = source.memberships;
    this.domains = source.domains;
    this.versions = source.versions;
    this.objects = source.objects;
  }

  async run(sql: string, values: readonly unknown[]): Promise<ReturnType<typeof result>> {
    return this.apply(sql, values);
  }

  async first<T>(sql: string, values: readonly unknown[]): Promise<T | null> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.includes('from workspace_memberships')) {
      const row = this.memberships.get(key(String(values[0]), String(values[1])));
      return (row ?? null) as T | null;
    }
    if (normalized.includes('from domain_versions')) {
      const row = this.versions.get(key(String(values[0]), String(values[1]), String(values[2])));
      return (row ?? null) as T | null;
    }
    throw new Error(`FakeD1Database does not support query: ${normalized}`);
  }

  async all<T>(sql: string, values: readonly unknown[]): Promise<{
    readonly success: true;
    readonly results: T[];
    readonly meta: Record<string, unknown>;
  }> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.includes('from domain_objects')) {
      const hashes = new Set(values.slice(2).map(String));
      return result([...this.objects.values()].filter((row) => row.workspace_id === values[0] && row.domain_id === values[1] && hashes.has(row.object_hash)) as T[]);
    }
    if (normalized.includes('from domains as d') && normalized.includes('inner join domain_versions as v')) {
      const workspaceId = String(values[0]);
      const rows = [...this.versions.values()]
        .filter((version) => version.workspace_id === workspaceId)
        .map((version) => {
          const domain = this.domains.get(key(version.workspace_id, version.domain_id));
          if (domain === undefined) {
            throw new Error('FakeD1Database domain row is missing for version');
          }
          return {
            workspace_id: version.workspace_id,
            domain_id: version.domain_id,
            domain_name: domain.name,
            version_id: version.version_id,
            model_json: version.model_json,
            published_at: version.published_at,
            catalog_object_json: this.objects.get(key(version.workspace_id, version.domain_id, String(JSON.parse(version.model_json).hash)))?.payload_json ?? null,
            // Emulate the AFTER INSERT head trigger, not lexical version order.
            current_version_id: [...this.versions.values()].filter((entry) => entry.workspace_id === version.workspace_id && entry.domain_id === version.domain_id).at(-1)?.version_id,
          };
        });
      return result(rows as T[]);
    }
    throw new Error(`FakeD1Database does not support query: ${normalized}`);
  }

  private async apply(sql: string, values: readonly unknown[]): Promise<ReturnType<typeof result>> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('insert into workspaces')) {
      const row: WorkspaceRow = { id: String(values[0]), created_at: String(values[1]) };
      this.workspaces.set(row.id, this.workspaces.get(row.id) ?? row);
      return result();
    }
    if (normalized.startsWith('insert into workspace_memberships')) {
      const row: WorkspaceMembershipRow = {
        workspace_id: String(values[0]),
        principal_id: String(values[1]),
        created_at: String(values[2]),
      };
      if (!this.workspaces.has(row.workspace_id)) {
        throw new Error('FOREIGN KEY constraint failed: workspace_memberships.workspace');
      }
      this.memberships.set(key(row.principal_id, row.workspace_id), row);
      return result();
    }
    if (normalized.startsWith('insert into domains')) {
      const row: DomainRow = {
        workspace_id: String(values[0]),
        id: String(values[1]),
        name: String(values[2]),
        created_at: String(values[3]),
      };
      if (!this.workspaces.has(row.workspace_id)) {
        throw new Error('FOREIGN KEY constraint failed: domains.workspace_id');
      }
      const rowKey = key(row.workspace_id, row.id);
      this.domains.set(rowKey, this.domains.get(rowKey) ?? row);
      return result();
    }
    if (normalized.startsWith('insert into domain_objects')) {
      for (let index = 0; index < values.length; index += 4) {
        const row: ObjectRow = { workspace_id: String(values[index]), domain_id: String(values[index + 1]), object_hash: String(values[index + 2]), payload_json: String(values[index + 3]) };
        if (!this.domains.has(key(row.workspace_id, row.domain_id))) throw new Error('FOREIGN KEY constraint failed: domain_objects.domain');
        const rowKey = key(row.workspace_id, row.domain_id, row.object_hash);
        if (!this.objects.has(rowKey)) this.objects.set(rowKey, row);
      }
      return result();
    }
    if (normalized.startsWith('insert into domain_versions')) {
      const row: VersionRow = {
        workspace_id: String(values[0]),
        domain_id: String(values[1]),
        version_id: String(values[2]),
        model_json: String(values[3]),
        published_at: String(values[4]),
        parent_version_id: [...this.versions.values()].filter((entry) => entry.workspace_id === values[0] && entry.domain_id === values[1]).at(-1)?.version_id ?? null,
      };
      if (!this.domains.has(key(row.workspace_id, row.domain_id))) {
        throw new Error('FOREIGN KEY constraint failed: domain_versions.domain');
      }
      const rowKey = key(row.workspace_id, row.domain_id, row.version_id);
      if (this.versions.has(rowKey)) {
        throw new Error('UNIQUE constraint failed: domain_versions');
      }
      this.versions.set(rowKey, row);
      return result();
    }
    throw new Error(`FakeD1Database does not support query: ${normalized}`);
  }

  /** Seed a server-side membership for authorization adapter tests. */
  seedWorkspaceMembership(workspaceId: string, principalId: string, createdAt = '2026-09-18T00:00:00.000Z'): void {
    this.workspaces.set(workspaceId, this.workspaces.get(workspaceId) ?? {
      id: workspaceId,
      created_at: createdAt,
    });
    this.memberships.set(key(principalId, workspaceId), {
      workspace_id: workspaceId,
      principal_id: principalId,
      created_at: createdAt,
    });
  }
}
