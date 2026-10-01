import type { D1DatabaseLike } from './domain-repository';
import type { DomainPatchModel } from '../domain/patch';

export class ProposalError extends Error {
  constructor(readonly code: 'RESOURCE_NOT_FOUND' | 'STALE_BASE_VERSION' | 'REVIEW_MISMATCH' | 'VERSION_CONFLICT') {
    super(code);
  }
}

export interface ProposalScope {
  readonly workspaceId: string;
  readonly domainId: string;
  readonly principalId: string;
}
export interface StoredProposal {
  readonly proposalId: string;
  readonly baseVersion: string;
  readonly versionId: string;
  readonly reviewDigest: string;
  readonly review: unknown;
  readonly candidate: DomainPatchModel;
}
export interface ProposalRepository {
  head(scope: ProposalScope): Promise<string>;
  authoringModel(scope: ProposalScope, versionId: string): Promise<DomainPatchModel | null>;
  save(scope: ProposalScope, proposal: StoredProposal): Promise<void>;
  commit(scope: ProposalScope, proposalId: string, reviewDigest: string): Promise<string>;
}
interface ProposalRow {
  readonly version_id: string;
  readonly review_digest: string;
}

/** All writes use server-owned candidates, never a model echoed by the client. */
export class D1ProposalRepository implements ProposalRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async head(scope: ProposalScope): Promise<string> {
    const row = await this.db.prepare(`SELECT version_id FROM domain_heads
      WHERE workspace_id = ? AND domain_id = ?`)
      .bind(scope.workspaceId, scope.domainId).first<{ version_id: string }>();
    if (!row) throw new ProposalError('RESOURCE_NOT_FOUND');
    return row.version_id;
  }

  async authoringModel(scope: ProposalScope, versionId: string): Promise<DomainPatchModel | null> {
    // Any authorized workspace member may build on a published version. Unpublished
    // proposals, in contrast, are private to the principal that generated them.
    const row = await this.db.prepare(`SELECT p.authoring_json FROM domain_proposals p
      INNER JOIN domain_versions v ON v.workspace_id = p.workspace_id
        AND v.domain_id = p.domain_id AND v.version_id = p.version_id AND v.proposal_id = p.proposal_id
      WHERE p.workspace_id = ? AND p.domain_id = ? AND p.version_id = ?`)
      .bind(scope.workspaceId, scope.domainId, versionId).first<{ authoring_json: string }>();
    return row ? JSON.parse(row.authoring_json) as DomainPatchModel : null;
  }

  async save(scope: ProposalScope, proposal: StoredProposal): Promise<void> {
    await this.db.prepare(`INSERT INTO domain_proposals
      (workspace_id, domain_id, proposal_id, principal_id, base_version, version_id,
       review_digest, review_json, model_json, authoring_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(scope.workspaceId, scope.domainId, proposal.proposalId, scope.principalId,
        proposal.baseVersion, proposal.versionId, proposal.reviewDigest,
        JSON.stringify(proposal.review), JSON.stringify(proposal.candidate.domain),
        JSON.stringify(proposal.candidate), new Date().toISOString()).run();
  }

  async commit(scope: ProposalScope, proposalId: string, reviewDigest: string): Promise<string> {
    const row = await this.db.prepare(`SELECT version_id, review_digest FROM domain_proposals
      WHERE workspace_id = ? AND domain_id = ? AND principal_id = ? AND proposal_id = ?`)
      .bind(scope.workspaceId, scope.domainId, scope.principalId, proposalId).first<ProposalRow>();
    if (!row) throw new ProposalError('RESOURCE_NOT_FOUND');
    if (row.review_digest !== reviewDigest) throw new ProposalError('REVIEW_MISMATCH');

    // The head comparison and insertion are ONE SQLite statement. The trigger
    // advances the head in the same transaction; two competing proposals cannot
    // both publish on the same base. A replay is a no-op, even after head advances.
    await this.db.prepare(`INSERT INTO domain_versions
      (workspace_id, domain_id, version_id, model_json, published_at, proposal_id)
      SELECT p.workspace_id, p.domain_id, p.version_id, p.model_json, ?, p.proposal_id
      FROM domain_proposals p
      INNER JOIN domain_heads h ON h.workspace_id = p.workspace_id AND h.domain_id = p.domain_id
      WHERE p.workspace_id = ? AND p.domain_id = ? AND p.principal_id = ?
        AND p.proposal_id = ? AND p.review_digest = ? AND h.version_id = p.base_version
      ON CONFLICT (workspace_id, domain_id, version_id) DO NOTHING`)
      .bind(new Date().toISOString(), scope.workspaceId, scope.domainId,
        scope.principalId, proposalId, reviewDigest).run();
    const published = await this.db.prepare(`SELECT version_id, proposal_id FROM domain_versions
      WHERE workspace_id = ? AND domain_id = ? AND version_id = ?`)
      .bind(scope.workspaceId, scope.domainId, row.version_id).first<{ version_id: string; proposal_id: string | null }>();
    if (!published) throw new ProposalError('STALE_BASE_VERSION');
    if (published.proposal_id !== proposalId) throw new ProposalError('VERSION_CONFLICT');
    return row.version_id;
  }
}
