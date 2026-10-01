import { describe, expect, it } from 'vitest';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import memberAgeBoundary from '../../fixtures/domain-v0/cases/member-age-boundary.json';
import {
  DOMAIN_PATCH_CONTRACT_VERSION,
  applyDomainPatch,
  parseDomainPatch,
  type DomainPatch,
} from './patch';

const provenance = { source: 'test:issue-12', actor: 'vitest' } as const;

const addedFunction = {
  id: 'function.patch.example',
  name: 'patch-example',
  description: 'Function added by a patch.',
  inputs: [],
  policy: {
    id: 'policy.patch.example',
    defaultStatus: 'allow',
    resolution: {
      priority: 'highest',
      unresolved: 'unresolved',
      conflict: 'conflict',
      ambiguous: 'ambiguous',
      noMatch: 'default',
    },
    rules: [],
  },
} as const;

const patchRule = {
  id: 'rule.patch.example',
  priority: 1,
  when: { id: 'node.patch.example', kind: 'literal', value: true },
  then: 'allow',
} as const;

function patch(operations: readonly unknown[], baseVersion = 'domain-v0'): DomainPatch {
  return {
    contractVersion: DOMAIN_PATCH_CONTRACT_VERSION,
    kind: 'domain-patch',
    baseVersion,
    provenance,
    operations: operations as DomainPatch['operations'],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('Domain Patch v0', () => {
  it('applies every supported operation through one explicit patch', () => {
    const result = applyDomainPatch(functionCatalog, patch([
      { op: 'add_type', type: { id: 'type.patch.country', name: 'Country', baseType: 'string' } },
      { op: 'add_function', function: addedFunction },
      { op: 'add_rule', functionId: addedFunction.id, rule: patchRule },
      { op: 'add_example', example: memberAgeBoundary },
      { op: 'mark_unknown', unknown: { id: 'unknown.patch.answer', subject: 'country', description: 'Country source is not specified.' } },
      { op: 'resolve_unknown', unknownId: 'unknown.patch.answer', resolution: 'user-provided' },
      { op: 'add_conflict', conflict: { id: 'conflict.patch.policy', subject: 'policy', alternatives: ['allow', 'deny'] } },
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.domain.functions.some((item) => item.id === addedFunction.id)).toBe(true);
    expect(result.value.domain.functions.find((item) => item.id === addedFunction.id)?.policy.rules).toHaveLength(1);
    expect(result.value.types.map((item) => item.id)).toEqual(['type.patch.country']);
    expect(result.value.examples.map((item) => item.id)).toEqual([memberAgeBoundary.id]);
    expect(result.value.unknowns).toEqual([]);
    expect(result.value.conflicts.map((item) => item.id)).toEqual(['conflict.patch.policy']);
  });

  it('requires a matching base version and provenance', () => {
    const stale = applyDomainPatch(functionCatalog, patch([], 'domain-v1'));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('STALE_BASE_VERSION');

    const model = {
      version: 'domain-v0',
      provenance: { source: 'other-source' },
      domain: functionCatalog,
      types: [],
      examples: [],
      unknowns: [],
      conflicts: [],
    };
    const mismatched = applyDomainPatch(model, patch([]));
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe('INVALID_PROVENANCE');
  });

  it('rejects unsupported and invalid operations without partial mutation', () => {
    const base = clone(functionCatalog);
    const before = JSON.stringify(base);
    const unsupported = parseDomainPatch(patch([{ op: 'rewrite_json', value: {} }]));
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(JSON.stringify(base)).toBe(before);

    const invalid = applyDomainPatch(base, patch([
      { op: 'add_type', type: { id: 'type.patch.invalid', name: 'Invalid', baseType: 'string' } },
      { op: 'add_rule', functionId: 'function.missing', rule: patchRule },
    ]));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_REFERENCE');
    expect(JSON.stringify(base)).toBe(before);
  });

  it('rejects duplicate IDs, including duplicates created inside one patch', () => {
    const duplicateFunction = applyDomainPatch(functionCatalog, patch([
      { op: 'add_function', function: addedFunction },
      { op: 'add_function', function: addedFunction },
    ]));
    expect(duplicateFunction.ok).toBe(false);
    if (!duplicateFunction.ok) expect(duplicateFunction.error.code).toBe('DUPLICATE_ID');

    const duplicateType = applyDomainPatch(functionCatalog, patch([
      { op: 'add_type', type: { id: 'type.patch.duplicate', name: 'Duplicate', baseType: 'string' } },
      { op: 'add_type', type: { id: 'type.patch.duplicate', name: 'Duplicate', baseType: 'string' } },
    ]));
    expect(duplicateType.ok).toBe(false);
    if (!duplicateType.ok) expect(duplicateType.error.code).toBe('DUPLICATE_ID');
  });

  it('revalidates an invalid final model with #24 semantic validation', () => {
    const invalidFinal = applyDomainPatch(functionCatalog, patch([{
      op: 'add_rule',
      functionId: 'function.domain-v0.member-age',
      rule: {
        id: 'rule.patch.bad-reference',
        priority: 10,
        when: { id: 'node.patch.bad-reference', kind: 'input', path: 'user.missing' },
        then: 'allow',
      },
    }]));
    expect(invalidFinal.ok).toBe(false);
    if (!invalidFinal.ok) {
      expect(invalidFinal.error.code).toBe('INVALID_REFERENCE');
      expect(invalidFinal.error.path).toBe('functions[0].policy.rules[2].when.path');
    }
  });

  it('is deterministic when the same patch is repeated against the same base', () => {
    const candidate = patch([
      { op: 'add_type', type: { id: 'type.patch.deterministic', name: 'Deterministic', baseType: 'number' } },
      { op: 'mark_unknown', unknown: { id: 'unknown.patch.deterministic', subject: 'threshold', description: 'Threshold is unknown.' } },
    ]);
    const first = applyDomainPatch(functionCatalog, candidate);
    const second = applyDomainPatch(functionCatalog, clone(candidate));
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('rejects a patch without provenance before applying any operation', () => {
    const invalid = clone(patch([{ op: 'add_type', type: { id: 'type.patch.no-provenance', name: 'No provenance', baseType: 'string' } }])) as unknown as Record<string, unknown>;
    delete invalid.provenance;
    const result = applyDomainPatch(functionCatalog, invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PROVENANCE');
  });
});

describe('JSON values retain their meaning at the patch boundary', () => {
  it('preserves __proto__ as a data key rather than a prototype assignment', () => {
    const resolution = JSON.parse('{"__proto__":{"verified":true},"answer":"unknown"}');
    const parsed = parseDomainPatch(patch([{ op: 'resolve_unknown', unknownId: 'u', resolution }]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const operation = parsed.value.operations[0];
      if (operation.op !== 'resolve_unknown') throw new Error('Wrong operation');
      expect(JSON.parse(JSON.stringify(operation.resolution))).toEqual(resolution);
    }
  });

  it('returns a typed failure for cyclic values rather than overflowing the stack', () => {
    const resolution: Record<string, unknown> = {};
    resolution.self = resolution;
    const value = patch([{ op: 'resolve_unknown', unknownId: 'u', resolution }]);
    expect(() => parseDomainPatch(value)).not.toThrow();
    expect(parseDomainPatch(value).ok).toBe(false);
  });

  it('rejects class instances instead of silently replacing them with an empty object', () => {
    const value = patch([{ op: 'resolve_unknown', unknownId: 'u', resolution: new Date('2026-01-01') }]);
    expect(parseDomainPatch(value).ok).toBe(false);
  });
});
