import { z } from 'zod';
import { generateValidatedDomainPatch, type ConversationPatchProvider } from '../domain/conversation-patch';
import type { DomainPatchModel } from '../domain/patch';
import { D1ProposalRepository, ProposalError, type ProposalRepository } from '../persistence/domain-proposals';
import { WorkspaceAccessError } from '../persistence/workspace-access';
import { createOpenAICompatibleProviderFromEnv } from '../provider';
import type { AccessPrincipal } from './access-auth';
import type { Env } from './env';
import type { McpWorkspaceRepository } from './mcp';

const id = z.string().trim().min(1).max(200);
export const proposeInputSchema = z.object({
  workspace: id,
  domain: id,
  baseVersion: id,
  conversation: z.array(z.object({
    id,
    // Client-supplied conversation is data, never a privileged system prompt.
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(12_000),
  }).strict()).min(1).max(50),
}).strict();
export const commitInputSchema = z.object({
  workspace: id,
  domain: id,
  proposalId: id,
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
}).strict();

export interface AuthoringDependencies {
  readonly repository: McpWorkspaceRepository;
  readonly proposals: ProposalRepository;
  readonly provider: () => ConversationPatchProvider;
}
export function productionAuthoringDependencies(env: Env, repository: McpWorkspaceRepository): AuthoringDependencies {
  if (!env.DB) throw new Error('D1 not configured');
  return {
    repository,
    proposals: new D1ProposalRepository(env.DB),
    provider: () => createOpenAICompatibleProviderFromEnv(env),
  };
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
const failure = (code: string) => ({ status: 'error' as const, error: { code } });
export function authoringFailure(error: unknown) {
  if (error instanceof WorkspaceAccessError) return failure('RESOURCE_NOT_FOUND');
  if (error instanceof ProposalError) return failure(error.code);
  // Provider bodies, prompts, credentials and database diagnostics never escape.
  return failure('AUTHORING_FAILED');
}

export async function proposeDomain(
  input: z.infer<typeof proposeInputSchema>, principal: AccessPrincipal, dependencies: AuthoringDependencies,
) {
  try {
    input = proposeInputSchema.parse(input);
    // Authorize and load before calling the paid/external provider.
    const workspace = await dependencies.repository.forPrincipal(principal, input.workspace);
    const record = await workspace.loadVersion({ domainId: input.domain, versionId: input.baseVersion });
    if (record.workspaceId !== input.workspace || record.domainId !== input.domain || record.versionId !== input.baseVersion) {
      return failure('RESOURCE_NOT_FOUND');
    }
    const scope = { workspaceId: input.workspace, domainId: input.domain, principalId: principal.subject };
    if (await dependencies.proposals.head(scope) !== input.baseVersion) return failure('STALE_BASE_VERSION');
    const stored = await dependencies.proposals.authoringModel(scope, input.baseVersion);
    // Provenance of previous edits remains in immutable proposal history. It must
    // not be mistaken for a requirement that future conversations share a source.
    const base: DomainPatchModel = {
      contractVersion: 'domain-v0', kind: 'domain-model', version: input.baseVersion,
      domain: record.model, types: stored?.types ?? [], examples: stored?.examples ?? [],
      unknowns: stored?.unknowns ?? [], conflicts: stored?.conflicts ?? [],
    };
    const generated = await generateValidatedDomainPatch({
      conversation: input.conversation, currentDomain: base,
      currentDomainVersion: input.baseVersion, unresolvedItems: base.unknowns,
    }, dependencies.provider(), { timeoutMs: 30_000 });
    if (!generated.ok) return failure(generated.error.code);
    if (await dependencies.proposals.head(scope) !== input.baseVersion) return failure('STALE_BASE_VERSION');
    const proposalId = crypto.randomUUID();
    const versionId = `proposal-${proposalId}`;
    const candidate = { ...generated.dryAppliedModel, version: versionId };
    const review = {
      workspace: input.workspace, domain: input.domain, baseVersion: input.baseVersion,
      version: versionId, patch: generated.patch,
      operationEvidence: generated.operationEvidence,
      sources: input.conversation.filter((turn) => generated.operationEvidence
        .some((evidence) => evidence.sourceReferences.includes(turn.id))),
      unknowns: candidate.unknowns, conflicts: candidate.conflicts,
      warning: 'Source references and structural validation do not prove semantic correctness. Review every operation before confirming.',
    };
    const reviewDigest = await digest(review);
    await dependencies.proposals.save(scope, {
      proposalId, baseVersion: input.baseVersion, versionId, reviewDigest, review, candidate,
    });
    return { status: 'proposed' as const, proposalId, reviewDigest, review, requiresConfirmation: true };
  } catch (error) {
    return authoringFailure(error);
  }
}

export async function commitDomain(
  input: z.infer<typeof commitInputSchema>, principal: AccessPrincipal, dependencies: AuthoringDependencies,
) {
  // Also guard direct callers; the MCP schema rejects false and omitted approval.
  if (input.confirmed !== true) return failure('CONFIRMATION_REQUIRED');
  try {
    await dependencies.repository.forPrincipal(principal, input.workspace);
    const version = await dependencies.proposals.commit({
      workspaceId: input.workspace, domainId: input.domain, principalId: principal.subject,
    }, input.proposalId, input.reviewDigest);
    return { status: 'committed' as const, workspace: input.workspace, domain: input.domain, version };
  } catch (error) {
    return authoringFailure(error);
  }
}
