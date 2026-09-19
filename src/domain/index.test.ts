import { describe, expect, it } from 'vitest';
import fixtureManifest from '../../fixtures/domain-v0/manifest.json';
import accountAllowActive from '../../fixtures/domain-v0/cases/account-allow-active.json';
import accountConflict from '../../fixtures/domain-v0/cases/account-conflict.json';
import accountAmbiguous from '../../fixtures/domain-v0/cases/account-ambiguous-multiple-allows.json';
import accountUnresolvedMissingCountry from '../../fixtures/domain-v0/cases/account-unresolved-missing-country.json';
import memberAgeBoundary from '../../fixtures/domain-v0/cases/member-age-boundary.json';
import memberAgeUnderage from '../../fixtures/domain-v0/cases/member-age-underage.json';
import refundDenyOverLimit from '../../fixtures/domain-v0/cases/refund-deny-over-limit.json';
import refundInvalidType from '../../fixtures/domain-v0/cases/refund-invalid-type.json';
import functionCatalog from '../../fixtures/domain-v0/functions.json';
import {
  DOMAIN_CONTRACT_VERSION,
  SUPPORTED_NODE_KINDS,
  SUPPORTED_OPERATORS,
  SUPPORTED_RESULT_STATUSES,
  getDomainMetadata,
  ping,
} from './index';

const GOLDEN_FIXTURES = [
  memberAgeBoundary,
  memberAgeUnderage,
  refundDenyOverLimit,
  accountAllowActive,
  accountUnresolvedMissingCountry,
  accountConflict,
  accountAmbiguous,
  refundInvalidType,
] as const;

function collectAstVocabulary(value: unknown, nodes: Set<string>, operators: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAstVocabulary(item, nodes, operators);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.kind === 'string') nodes.add(record.kind);
  if (typeof record.operator === 'string') operators.add(record.operator);
  if (record.kind === 'not') operators.add('not');
  for (const child of Object.values(record)) collectAstVocabulary(child, nodes, operators);
}

function collectIds(value: unknown, ids: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, ids);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string') ids.push(record.id);
  for (const child of Object.values(record)) collectIds(child, ids);
}

describe('Domain Core (ドメインコア)', () => {
  it('外部依存なしに正常なドメインメタデータを返却する', () => {
    const metadata = getDomainMetadata();
    expect(metadata).toEqual({
      name: 'invariant-domain-core',
      version: '0.0.1',
      status: 'ready',
    });
  });

  it('ping を決定論的に評価して { ok: true } を返却する', () => {
    const result = ping();
    expect(result).toEqual({ ok: true });
  });

  it('v0 のJSON文書を読み込め、fixture IDが一意である', () => {
    const documents: unknown[] = [fixtureManifest, functionCatalog, ...GOLDEN_FIXTURES];
    for (const document of documents) {
      expect(document).toBeTypeOf('object');
      expect(() => JSON.parse(JSON.stringify(document))).not.toThrow();
    }

    const fixtureIds = GOLDEN_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    expect(fixtureIds).toEqual(fixtureManifest.fixtures.map((fixture) => fixture.id));
    expect(fixtureIds.every((id) => /^fixture\.domain-v0\.[a-z0-9-]+$/.test(id))).toBe(true);
  });

  it('catalog IDs are stable and unique', () => {
    const ids: string[] = [];
    collectIds(functionCatalog, ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      ids.every((id) => /^(function|policy|rule|node)\.domain-v0\.[a-z0-9.-]+$/.test(id))
    ).toBe(true);
  });

  it('supported nodes/operators/statuses are represented by fixtures', () => {
    const nodes = new Set<string>();
    const operators = new Set<string>();
    collectAstVocabulary(functionCatalog, nodes, operators);

    expect(fixtureManifest.supported.nodeKinds).toEqual([...SUPPORTED_NODE_KINDS]);
    expect(fixtureManifest.supported.operators).toEqual([...SUPPORTED_OPERATORS]);
    expect(fixtureManifest.supported.statuses).toEqual([...SUPPORTED_RESULT_STATUSES]);
    expect(SUPPORTED_NODE_KINDS.every((kind) => nodes.has(kind))).toBe(true);
    expect(SUPPORTED_OPERATORS.every((operator) => operators.has(operator))).toBe(true);

    const statuses = new Set(GOLDEN_FIXTURES.map((fixture) => fixture.expected.status));
    expect(SUPPORTED_RESULT_STATUSES.every((status) => statuses.has(status))).toBe(true);
  });

  it('same-priority same-decision matches remain explicitly ambiguous', () => {
    expect(accountAmbiguous.expected.status).toBe('ambiguous');
    expect(accountAmbiguous.expected.value).toBeNull();
    expect(accountAmbiguous.expected.errors).toEqual([
      {
        code: 'AMBIGUOUS_MATCH',
        message: 'Multiple highest-priority rules agree but do not identify a unique decision.',
        ruleIds: [
          'rule.domain-v0.account-review.allow-review-state',
          'rule.domain-v0.account-review.allow-trusted-country',
        ],
      },
    ]);
    expect(accountAmbiguous.expected.matchedRuleIds).toEqual(
      accountAmbiguous.expected.provenance.ruleIds,
    );
    expect(accountAmbiguous.expected.trace[accountAmbiguous.expected.trace.length - 1]).toMatchObject({
      stage: 'policy',
      outcome: 'ambiguous',
    });
  });

  it('each golden result has a reviewable expected-result shape', () => {
    const functionIds = new Set(functionCatalog.functions.map((domainFunction) => domainFunction.id));

    for (const fixture of GOLDEN_FIXTURES) {
      expect(fixture.contractVersion).toBe(DOMAIN_CONTRACT_VERSION);
      expect(functionIds.has(fixture.functionId)).toBe(true);
      expect(fixture.expected).toMatchObject({
        status: expect.any(String),
        matchedRuleIds: expect.any(Array),
        unresolvedPaths: expect.any(Array),
        errors: expect.any(Array),
        trace: expect.any(Array),
        provenance: {
          fixtureId: fixture.id,
          functionId: fixture.functionId,
          policyId: expect.any(String),
          inputPaths: expect.any(Array),
          ruleIds: expect.any(Array),
        },
      });
      expect(fixture.expected.value).toBe(
        fixture.expected.status === 'allow'
          ? true
          : fixture.expected.status === 'deny'
            ? false
            : null
      );

      const traceIds = fixture.expected.trace.map((event) => event.id);
      expect(new Set(traceIds).size).toBe(traceIds.length);
      expect(traceIds.every((id) => /^trace\.domain-v0\.[a-z0-9.-]+$/.test(id))).toBe(true);
    }
  });
});
