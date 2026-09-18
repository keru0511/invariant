import { describe, expect, it } from 'vitest';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import memberAgeBoundary from '../../fixtures/domain-v0/cases/member-age-boundary.json';
import {
  CONVERSATION_PATCH_OUTPUT_SCHEMA,
  generateValidatedDomainPatch,
  type ConversationPatchProvider,
  type ConversationPatchProviderRequest,
} from './conversation-patch';
import { DOMAIN_PATCH_CONTRACT_VERSION } from './patch';

const conversation = [
  { id: 'turn-1', role: 'user' as const, content: 'Members under 18 are denied.' },
  { id: 'turn-2', role: 'assistant' as const, content: 'The age rule is recorded, but country is still unspecified.' },
];

const provenance = { source: 'conversation', actor: 'fake-provider', reference: 'turn-1' } as const;

function providerReturning(output: unknown): ConversationPatchProvider {
  return { generate: async (_request: ConversationPatchProviderRequest) => output };
}

function patch(operations: readonly unknown[]) {
  return {
    contractVersion: DOMAIN_PATCH_CONTRACT_VERSION,
    kind: 'domain-patch' as const,
    baseVersion: 'domain-v0',
    provenance,
    operations,
  };
}

function evidence(operationCount: number) {
  return Array.from({ length: operationCount }, (_, operationIndex) => ({ operationIndex, sourceReferences: ['turn-1'] }));
}

describe('conversation-to-validated-patch', () => {
  it('synthetic conversation produces the expected patch', async () => {
    const output = {
      patch: patch([
        {
          op: 'add_rule',
          functionId: 'function.domain-v0.member-age',
          rule: {
            id: 'rule.conversation.member-age',
            priority: 20,
            when: { id: 'node.conversation.member-age', kind: 'literal', value: true },
            then: 'deny',
          },
        },
        {
          op: 'mark_unknown',
          unknown: { id: 'unknown.conversation.country', kind: 'unknown', subject: 'member.country', description: 'The conversation does not define the member country.' },
        },
        {
          op: 'add_conflict',
          conflict: { id: 'conflict.conversation.review', kind: 'conflict', subject: 'manual review', alternatives: ['required', 'not-required'] },
        },
      ]),
      operationEvidence: evidence(3),
    };

    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, providerReturning(output));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toEqual(output.patch);
    expect(result.dryAppliedModel.unknowns.map((item) => item.id)).toEqual(['unknown.conversation.country']);
    expect(result.dryAppliedModel.conflicts.map((item) => item.id)).toEqual(['conflict.conversation.review']);
  });

  it('concrete conversation becomes an add_example operation', async () => {
    const output = { patch: patch([{ op: 'add_example', example: memberAgeBoundary }]), operationEvidence: evidence(1) };
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, providerReturning(output));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.operations).toEqual([{ op: 'add_example', example: memberAgeBoundary }]);
    expect(result.dryAppliedModel.examples.map((example) => example.id)).toEqual([memberAgeBoundary.id]);
  });

  it('missing definitions are not invented', async () => {
    const invented = {
      patch: patch([{ op: 'add_type', type: { id: 'type.invented.country', name: 'Country', description: 'Invented without a source.', baseType: 'string' } }]),
      operationEvidence: [],
    };
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, providerReturning(invented));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MALFORMED_OUTPUT');
  });

  it('rejects unknown source references and provenance', async () => {
    const output = {
      patch: {
        ...patch([{ op: 'mark_unknown', unknown: { id: 'unknown.conversation.source', kind: 'unknown', subject: 'country', description: 'Country is unspecified.' } }]),
        provenance: { source: 'conversation', actor: 'fake-provider', reference: 'turn-missing' },
      },
      operationEvidence: [{ operationIndex: 0, sourceReferences: ['turn-missing'] }],
    };
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, providerReturning(output));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_SOURCE_REFERENCE' } });
  });

  it('malformed provider output is rejected without model mutation', async () => {
    const current = JSON.parse(JSON.stringify(functionCatalog));
    const before = JSON.stringify(current);
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: current, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, providerReturning({ patch: { kind: 'domain-patch' }, operationEvidence: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MALFORMED_OUTPUT');
    expect(JSON.stringify(current)).toBe(before);
  });

  it('provider timeout returns a typed failure', async () => {
    const never: ConversationPatchProvider = { generate: async () => new Promise(() => undefined) };
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, never, { timeoutMs: 5 });
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_TIMEOUT' } });
  });

  it('provider error returns a typed failure', async () => {
    const provider: ConversationPatchProvider = { generate: async () => { throw new Error('fake provider unavailable'); } };
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider);
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_ERROR' } });
  });

  it('passes one structured output schema to the provider boundary', async () => {
    let received: ConversationPatchProviderRequest | undefined;
    const provider: ConversationPatchProvider = { generate: async (request) => { received = request; return { patch: patch([]), operationEvidence: [] }; } };
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider);
    expect(result.ok).toBe(true);
    expect(received?.outputSchema).toBe(CONVERSATION_PATCH_OUTPUT_SCHEMA);
    expect(received?.currentDomainVersion).toBe('domain-v0');
  });
});
