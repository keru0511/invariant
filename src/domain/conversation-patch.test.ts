import { describe, expect, it } from 'vitest';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import memberAgeBoundary from '../../fixtures/domain-v0/cases/member-age-boundary.json';
import {
  CONVERSATION_PATCH_OUTPUT_SCHEMA,
  generateValidatedDomainPatch,
  type ConversationPatchClock,
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

function providerSequence(outputs: readonly unknown[]) {
  const requests: ConversationPatchProviderRequest[] = [];
  const provider: ConversationPatchProvider = {
    generate: async (request) => {
      requests.push(request);
      return outputs[Math.min(requests.length - 1, outputs.length - 1)];
    },
  };
  return { provider, requests };
}

class FakeClock implements ConversationPatchClock {
  private nextHandle = 0;
  private readonly timers = new Map<number, { readonly dueAt: number; readonly handler: () => void }>();
  now = 0;

  setTimeout(handler: () => void, timeoutMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { dueAt: this.now + timeoutMs, handler });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(timeoutMs: number): void {
    this.now += timeoutMs;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.dueAt <= this.now);
    for (const [handle, timer] of due) {
      this.timers.delete(handle);
      timer.handler();
    }
  }

  get pendingCount(): number {
    return this.timers.size;
  }
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
    if (!result.ok) expect(result.error.code).toBe('REPAIR_EXHAUSTED');
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
    expect(result).toMatchObject({ ok: false, error: { code: 'REPAIR_EXHAUSTED', attempts: 2 } });
  });

  it('malformed provider output is rejected without model mutation', async () => {
    const current = JSON.parse(JSON.stringify(functionCatalog));
    const before = JSON.stringify(current);
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: current, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, providerReturning({ patch: { kind: 'domain-patch' }, operationEvidence: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('REPAIR_EXHAUSTED');
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

  it('valid first response uses exactly one provider call', async () => {
    const output = { patch: patch([]), operationEvidence: [] };
    const sequence = providerSequence([output]);
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, sequence.provider);
    expect(result.ok).toBe(true);
    expect(sequence.requests).toHaveLength(1);
    expect(sequence.requests[0]).toMatchObject({ attempt: 1 });
    expect(sequence.requests[0].repair).toBeUndefined();
  });

  it('invalid then valid response retries once with structured diagnostics', async () => {
    const invalid = { patch: { kind: 'domain-patch' }, operationEvidence: [] };
    const valid = { patch: patch([]), operationEvidence: [] };
    const sequence = providerSequence([invalid, valid]);
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, sequence.provider);
    expect(result.ok).toBe(true);
    expect(sequence.requests).toHaveLength(2);
    expect(sequence.requests[1].attempt).toBe(2);
    expect(sequence.requests[1].repair).toEqual({
      previousAttempt: 1,
      diagnostics: [{ code: 'INVALID_PATCH', path: '$.contractVersion', message: 'Unsupported Domain Patch contract version.' }],
    });
  });

  it('two invalid responses return typed exhausted failure without mutation', async () => {
    const current = JSON.parse(JSON.stringify(functionCatalog));
    const before = JSON.stringify(current);
    const invalid = { patch: { kind: 'domain-patch' }, operationEvidence: [] };
    const sequence = providerSequence([invalid, invalid]);
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: current, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, sequence.provider);
    expect(result).toMatchObject({ ok: false, error: { code: 'REPAIR_EXHAUSTED', attempts: 2 } });
    if (!result.ok) expect(result.error.attemptDiagnostics).toHaveLength(2);
    expect(sequence.requests).toHaveLength(2);
    expect(JSON.stringify(current)).toBe(before);
  });

  it('repair does not invent missing definitions', async () => {
    const invalid = {
      patch: patch([{ op: 'add_type', type: { id: 'type.invented.country', name: 'Country', description: 'Invented without a source.', baseType: 'string' } }]),
      operationEvidence: [],
    };
    const sequence = providerSequence([invalid, invalid]);
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, sequence.provider);
    expect(result.ok).toBe(false);
    expect(sequence.requests).toHaveLength(2);
    expect(sequence.requests[1].repair?.diagnostics[0].code).toBe('MALFORMED_OUTPUT');
  });

  it('provider timeout is bounded to one attempt by the fake clock', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const provider: ConversationPatchProvider = {
      generate: async () => {
        calls += 1;
        return new Promise(() => undefined);
      },
    };
    const pending = generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider, { timeoutMs: 10, clock });
    expect(calls).toBe(1);
    expect(clock.pendingCount).toBe(1);
    clock.advance(9);
    expect(calls).toBe(1);
    clock.advance(1);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROVIDER_TIMEOUT', attempts: 1 } });
    expect(calls).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it('invalid repair is bounded to two attempts and one timeout window', async () => {
    const clock = new FakeClock();
    const invalid = { patch: { kind: 'domain-patch' }, operationEvidence: [] };
    const sequence = providerSequence([invalid, new Promise(() => undefined)]);
    const pending = generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, sequence.provider, { timeoutMs: 7, clock });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sequence.requests).toHaveLength(2);
    expect(clock.pendingCount).toBe(1);
    clock.advance(7);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROVIDER_TIMEOUT', attempts: 2 } });
    expect(sequence.requests).toHaveLength(2);
  });

  it('cancellation and provider/config errors remain explicit and bounded', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    let calls = 0;
    const provider: ConversationPatchProvider = { generate: async () => { calls += 1; return { patch: patch([]), operationEvidence: [] }; } };
    const cancelledResult = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider, { signal: cancelled.signal });
    expect(cancelledResult).toMatchObject({ ok: false, error: { code: 'PROVIDER_CANCELLED', attempts: 1 } });
    expect(calls).toBe(0);
    const configResult = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider, { timeoutMs: 0 });
    expect(configResult).toMatchObject({ ok: false, error: { code: 'CONFIG_ERROR' } });
    const providerError = await generateValidatedDomainPatch({ conversation, currentDomain: functionCatalog, currentDomainVersion: 'domain-v0', unresolvedItems: [] }, { generate: async () => { throw new Error('unavailable'); } });
    expect(providerError).toMatchObject({ ok: false, error: { code: 'PROVIDER_ERROR', attempts: 1 } });
  });
});



describe('immutable provider boundary', () => {
  it('uses the original snapshot even if the caller changes it while the provider is pending', async () => {
    const original = structuredClone(functionCatalog);
    const turns = structuredClone(conversation);
    let release!: (value: unknown) => void;
    const pendingOutput = new Promise<unknown>((resolve) => { release = resolve; });
    const provider = { generate: async () => pendingOutput };
    const pending = generateValidatedDomainPatch({ conversation: turns, currentDomain: original,
      currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider);
    original.functions.length = 0;
    turns[0].id = 'changed-after-start';
    turns[0].content = 'A different instruction';
    release({ patch: patch([]), operationEvidence: [] });
    const actual = await pending;
    expect(actual.ok).toBe(true);
    if (actual.ok) expect(actual.dryAppliedModel.domain.functions).toHaveLength(functionCatalog.functions.length);
  });

  it('does not give the provider mutable references to caller-owned knowledge', async () => {
    const original = structuredClone(functionCatalog);
    const turns = structuredClone(conversation);
    let requestSnapshot: ConversationPatchProviderRequest | undefined;
    const actual = await generateValidatedDomainPatch({ conversation: turns, currentDomain: original,
      currentDomainVersion: 'domain-v0', unresolvedItems: [] }, { generate: async (request) => {
        requestSnapshot = request;
        return { patch: patch([]), operationEvidence: [] };
      } });
    expect(actual.ok).toBe(true);
    expect(requestSnapshot?.currentDomain).not.toBe(original);
    expect(requestSnapshot?.conversation).not.toBe(turns);
    expect(Object.isFrozen(requestSnapshot?.currentDomain)).toBe(true);
    expect(Object.isFrozen(requestSnapshot?.conversation[0])).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });
});

 it('keeps nested provider schema immutable across requests', () => {
   expect(Object.isFrozen(CONVERSATION_PATCH_OUTPUT_SCHEMA.properties.patch.properties.operations.items.properties.op.enum)).toBe(true);
   expect(Object.isFrozen(CONVERSATION_PATCH_OUTPUT_SCHEMA.properties.operationEvidence.items.required)).toBe(true);
 });

describe('validate knowledge before invoking a provider', () => {
  it('rejects an invalid source domain without spending a provider attempt', async () => {
    let calls = 0;
    const provider = { generate: async () => { calls++; return { patch: patch([]), operationEvidence: [] }; } };
    const result = await generateValidatedDomainPatch({ conversation, currentDomain: { invalid: true },
      currentDomainVersion: 'domain-v0', unresolvedItems: [] }, provider);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toBe(0);
  });

  it('rejects inconsistent unresolved items rather than presenting two different knowledge states', async () => {
    let calls = 0;
    const currentDomain = { contractVersion: 'domain-v0', kind: 'domain-model', version: 'domain-v0', domain: functionCatalog,
      types: [], examples: [], conflicts: [], unknowns: [{ id: 'u', kind: 'unknown', subject: 'country', description: 'Unknown' }] };
    const result = await generateValidatedDomainPatch({ conversation, currentDomain, currentDomainVersion: 'domain-v0', unresolvedItems: [] },
      { generate: async () => { calls++; return { patch: patch([]), operationEvidence: [] }; } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toBe(0);
  });
});
