import type { AccessPrincipal } from '../worker/access-auth';
import type {
  CreateDomainInput,
  D1DatabaseLike,
  D1DomainRepository,
  DomainSearchCandidate,
  DomainSearchMatch,
  DomainVersionRecord,
  LoadDomainVersionInput,
  PublishDomainVersionInput,
  SearchDomainInput,
} from './domain-repository';

const SELECT_MEMBERSHIP = `
  SELECT workspace_id
  FROM workspace_memberships
  WHERE principal_id = ? AND workspace_id = ?
`;

export const PUBLIC_RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND' as const;

export class WorkspaceAccessError extends Error {
  readonly name = 'WorkspaceAccessError';
  readonly code: typeof PUBLIC_RESOURCE_NOT_FOUND;

  constructor() {
    super('Resource not found.');
    this.code = PUBLIC_RESOURCE_NOT_FOUND;
  }
}

export interface WorkspaceScope {
  readonly workspaceId: string;
  readonly principalId: string;
}

interface MembershipRow {
  readonly workspace_id: string;
}

export interface WorkspaceMembershipRepository {
  authorize(principal: AccessPrincipal, workspaceId: string): Promise<WorkspaceScope>;
}

function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new WorkspaceAccessError();
  }
  return value;
}

function statement(db: D1DatabaseLike, sql: string, ...values: unknown[]) {
  return db.prepare(sql).bind(...values);
}

export class D1WorkspaceMembershipRepository implements WorkspaceMembershipRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async authorize(principal: AccessPrincipal, workspaceId: string): Promise<WorkspaceScope> {
    const principalId = identifier(principal.subject, 'principal.subject');
    const requestedWorkspaceId = identifier(workspaceId, 'workspaceId');
    const row = await statement(
      this.db,
      SELECT_MEMBERSHIP,
      principalId,
      requestedWorkspaceId,
    ).first<MembershipRow>();

    if (row === null) {
      // Deliberately use the same public category as an absent domain resource.
      throw new WorkspaceAccessError();
    }

    return Object.freeze({
      workspaceId: row.workspace_id,
      principalId,
    });
  }
}

export interface ScopedCreateDomainInput {
  readonly domainId: string;
  readonly name: string;
}

export interface ScopedPublishDomainVersionInput {
  readonly domainId: string;
  readonly versionId: string;
  readonly model: unknown;
}

export interface ScopedLoadDomainVersionInput {
  readonly domainId: string;
  readonly versionId: string;
}

export interface ScopedSearchDomainInput {
  readonly query: string;
  readonly limit: number;
}

export type DomainRepositoryPort = Pick<
  D1DomainRepository,
  'createDomain' | 'publishVersion' | 'loadVersion' | 'search'
>;

/**
 * A domain repository whose workspace is fixed by server-side membership.
 * Its public methods intentionally have no workspaceId argument, so request
 * handlers cannot accidentally pass a client-selected workspace to storage.
 */
export class WorkspaceScopedDomainRepository {
  constructor(
    private readonly repository: DomainRepositoryPort,
    private readonly scope: WorkspaceScope,
  ) {}

  async createDomain(input: ScopedCreateDomainInput): Promise<void> {
    const request: CreateDomainInput = {
      ...input,
      workspaceId: this.scope.workspaceId,
    };
    await this.repository.createDomain(request);
  }

  async publishVersion(input: ScopedPublishDomainVersionInput): Promise<DomainVersionRecord> {
    const request: PublishDomainVersionInput = {
      ...input,
      workspaceId: this.scope.workspaceId,
    };
    return this.repository.publishVersion(request);
  }

  async loadVersion(input: ScopedLoadDomainVersionInput): Promise<DomainVersionRecord> {
    const request: LoadDomainVersionInput = {
      ...input,
      workspaceId: this.scope.workspaceId,
    };
    const record = await this.repository.loadVersion(request);
    if (record === null) {
      // Foreign and nonexistent resources share this category. Foreign access
      // is rejected before the domain repository is called by the adapter.
      throw new WorkspaceAccessError();
    }
    return record;
  }

  async search(input: ScopedSearchDomainInput): Promise<readonly DomainSearchMatch[]> {
    const request: SearchDomainInput = {
      ...input,
      workspaceId: this.scope.workspaceId,
    };
    const candidates = await this.repository.search(request);
    return Object.freeze(candidates
      .filter((candidate: DomainSearchCandidate) => candidate.workspaceId === this.scope.workspaceId)
      .map(({ workspaceId: _workspaceId, ...match }) => match));
  }
}

/**
 * Auth/workspace adapter used by request paths. It resolves the verified
 * principal against a membership table before exposing any domain operation.
 */
export class AuthWorkspaceRepositoryAdapter {
  constructor(
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly domains: DomainRepositoryPort,
  ) {}

  async forPrincipal(
    principal: AccessPrincipal,
    requestedWorkspaceId: string,
  ): Promise<WorkspaceScopedDomainRepository> {
    const scope = await this.memberships.authorize(principal, requestedWorkspaceId);
    return new WorkspaceScopedDomainRepository(this.domains, scope);
  }
}
