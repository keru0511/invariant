import { describe, expect, it } from 'vitest';
import rule from '../../fixtures/empirical-v1/rule.json';
import corpus from '../../fixtures/empirical-v1/public-cases.json';
import oracle from '../../fixtures/empirical-v1/oracle.json';
import {
  describeEmpiricalCancellation,
  EMPIRICAL_CANCELLATION_CORPUS_VERSION,
  EMPIRICAL_CANCELLATION_RULE_TEXT,
  EMPIRICAL_CANCELLATION_RULE_VERSION,
  EMPIRICAL_CANCELLATION_SOURCE_ID,
  EMPIRICAL_CANCELLATION_TOOL_EXECUTOR,
  EMPIRICAL_CANCELLATION_TOOLS,
  evaluateEmpiricalCancellation,
  executeEmpiricalCancellationTool,
} from './empirical-cancellation';

const request = <T extends Record<string, unknown>>(args: T) => ({ domain: 'synthetic-cancellation', version: 'cancellation-v1', function: 'cancellation-fee', args });
const base = { organizerCancelled: false, secondsUntilStart: 86400, bookingPriceYen: '3333' };

// The hand-authored oracle is a test input, never created from executable output.
describe('synthetic cancellation independent fixture oracle', () => {
  it.each(oracle.cases)('matches handwritten expectation $caseId', (gold) => {
    const question = corpus.cases.find((item) => item.id === gold.caseId)!;
    expect(question).toBeDefined();
    // Scoring targets are checked for agreement, not supplied to model inputs.
    expect(gold.toolTarget.arguments.args).toEqual(question.facts);
    const result = evaluateEmpiricalCancellation(gold.toolTarget.arguments);
    expect(result.status).toBe(gold.answer.abstain ? 'needs_information' : 'ok');
    if (result.status === 'error') throw new Error(result.error.message);
    const answer = { decision: result.decision, abstain: result.abstain, ...('value' in result ? { value: result.value } : {}) };
    expect(answer).toEqual(gold.answer);
    expect(result).toMatchObject({ version: rule.version, sourceId: rule.sourceId, corpusVersion: rule.corpusVersion });
  });

  it('keeps the same published text in every condition input and labels the split honestly', () => {
    expect(rule.version).toBe(EMPIRICAL_CANCELLATION_RULE_VERSION);
    expect(rule.corpusVersion).toBe(EMPIRICAL_CANCELLATION_CORPUS_VERSION);
    expect(rule.sourceId).toBe(EMPIRICAL_CANCELLATION_SOURCE_ID);
    expect(rule.ruleText).toBe(EMPIRICAL_CANCELLATION_RULE_TEXT);
    expect(corpus.cases.filter((item) => item.split === 'development')).toHaveLength(4);
    expect(corpus.cases.filter((item) => item.split === 'reserved-evaluation')).toHaveLength(8);
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(12);
    expect(new Set(oracle.cases.map((item) => item.caseId))).toEqual(new Set(corpus.cases.map((item) => item.id)));
    for (const item of corpus.cases) {
      expect(item.ruleText).toBe(rule.ruleText);
      expect(item.corpusVersion).toBe(rule.corpusVersion);
      expect(item.ruleTextRef).toBe('./rule.json#ruleText');
      expect(item).not.toHaveProperty('answer');
      expect(item).not.toHaveProperty('toolTarget');
      expect(item).not.toHaveProperty('expected');
    }
    expect(rule.answerSchema.properties.decision.enum).toEqual(['free', 'half', 'full', null]);
    const followups = corpus.cases.filter((item) => 'followupQuestions' in item);
    expect(followups).toHaveLength(2);
    for (const item of followups) {
      const gold = oracle.cases.find((candidate) => candidate.caseId === item.id)!;
      expect(gold.turnAnswers).toHaveLength(2);
      expect(gold.turnAnswers?.[1]).toEqual(gold.answer);
    }
    expect(oracle.reviewStatus).toContain('human review pending');
    expect(corpus.splitNotice).toContain('モデル試行は未実施');
  });
});

describe('pure cancellation exact arithmetic and necessary facts', () => {
  it.each([
    [172801, 'free', '0'], [172800, 'free', '0'], [172799, 'half', '1666'],
    [86401, 'half', '1666'], [86400, 'half', '1666'], [86399, 'full', '3333'], [0, 'full', '3333'],
  ])('evaluates exact boundary %s', (secondsUntilStart, decision, value) => {
    expect(evaluateEmpiricalCancellation(request({ ...base, secondsUntilStart }))).toMatchObject({ status: 'ok', decision, value });
  });
  it('keeps integer yen exact beyond Number precision', () => {
    expect(evaluateEmpiricalCancellation(request({ ...base, bookingPriceYen: '9007199254740993' }))).toMatchObject({ value: '4503599627370496' });
    expect(evaluateEmpiricalCancellation(request({ ...base, bookingPriceYen: '1' }))).toMatchObject({ decision: 'half', value: '0' });
    expect(evaluateEmpiricalCancellation(request({ ...base, bookingPriceYen: '9'.repeat(100) }))).toMatchObject({ value: '4' + '9'.repeat(99) });
  });
  it('uses the organizer exception with no invented time or amount', () => {
    expect(evaluateEmpiricalCancellation(request({ organizerCancelled: true }))).toMatchObject({ decision: 'free', value: '0', reason: 'organizer_exception' });
  });
  it('does not ask irrelevant facts once >=48h independently establishes free', () => {
    expect(evaluateEmpiricalCancellation(request({ secondsUntilStart: 172800 }))).toMatchObject({ status: 'ok', decision: 'free', value: '0', reason: 'at_least_48_hours' });
  });
  it.each([
    [{}, 'organizerCancelled'],
    [{ secondsUntilStart: 43200, bookingPriceYen: '3333' }, 'organizerCancelled'],
    [{ organizerCancelled: false, bookingPriceYen: '3333' }, 'secondsUntilStart'],
    [{ organizerCancelled: false, secondsUntilStart: 86400 }, 'bookingPriceYen'],
  ])('asks the next necessary fact without an amount claim', (facts, field) => {
    const result = evaluateEmpiricalCancellation(request(facts));
    expect(result).toMatchObject({ status: 'needs_information', decision: null, abstain: true, missingFacts: [field] });
    expect(result).not.toHaveProperty('value');
  });
});

describe('conservative experiment tool boundary', () => {
  it.each(['3333.0', '03', '-1', '+1', '3,333', ' 3333', '', '０', '0', '9'.repeat(101), 3333, null, undefined])('rejects invalid/out-of-scope supplied yen %s', (bookingPriceYen) => {
    expect(evaluateEmpiricalCancellation(request({ ...base, bookingPriceYen }))).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } });
  });
  it.each([-1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '86400', null, undefined])('rejects invalid supplied seconds %s even with the organizer exception', (secondsUntilStart) => {
    expect(evaluateEmpiricalCancellation(request({ organizerCancelled: true, secondsUntilStart }))).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } });
  });
  it.each(['false', 0, null, undefined])('does not coerce organizer flag %s', (organizerCancelled) => {
    expect(evaluateEmpiricalCancellation(request({ ...base, organizerCancelled }))).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } });
  });
  it('validates all supplied fields before taking the organizer or >=48h short circuit', () => {
    expect(evaluateEmpiricalCancellation(request({ organizerCancelled: true, bookingPriceYen: 'no' }))).toMatchObject({ status: 'error' });
    expect(evaluateEmpiricalCancellation(request({ secondsUntilStart: 172800, organizerCancelled: 'unknown' }))).toMatchObject({ status: 'error' });
    expect(evaluateEmpiricalCancellation(request({ ...base, approvedOverridePercent: 50 }))).toMatchObject({ status: 'error' });
  });
  it('requires the exact version and does not default to the available rule', () => {
    expect(evaluateEmpiricalCancellation({ ...request(base), version: 'cancellation-v2' })).toMatchObject({ status: 'error', error: { code: 'VERSION_MISMATCH' } });
    const { version: _, ...missing } = request(base);
    expect(evaluateEmpiricalCancellation(missing)).toMatchObject({ status: 'error', error: { code: 'VERSION_MISMATCH' } });
    expect(evaluateEmpiricalCancellation({ ...request(base), domain: 'real-business' })).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_DOMAIN' } });
    expect(evaluateEmpiricalCancellation({ ...request(base), function: 'commit-change' })).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_FUNCTION' } });
  });
  it('rejects non-JSON objects and accessors without reading accessor values', () => {
    let getterCalls = 0;
    const args = { ...base };
    Object.defineProperty(args, 'bookingPriceYen', { get() { getterCalls++; return '3333'; }, enumerable: true });
    expect(evaluateEmpiricalCancellation(request(args))).toMatchObject({ status: 'error' });
    expect(getterCalls).toBe(0);
    expect(evaluateEmpiricalCancellation(request(Object.create(base)))).toMatchObject({ status: 'error' });
    expect(evaluateEmpiricalCancellation(request({ ...base, [Symbol('hidden')]: 1 }))).toMatchObject({ status: 'error' });
    expect(evaluateEmpiricalCancellation(request(new Date() as unknown as Record<string, unknown>))).toMatchObject({ status: 'error' });
    expect(evaluateEmpiricalCancellation(null)).toMatchObject({ status: 'error' });
  });
  it('keeps the input untouched and returns immutable deterministic results', () => {
    const input = Object.freeze({ ...request(Object.freeze({ ...base })) });
    const first = evaluateEmpiricalCancellation(input);
    expect(evaluateEmpiricalCancellation(input)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(input.args).toEqual(base);
  });
  it('describes the pinned experimental source, not a deployed MCP registration', () => {
    const description = describeEmpiricalCancellation({ domain: 'synthetic-cancellation', version: 'cancellation-v1' });
    expect(description).toMatchObject({ status: 'ok', scope: 'synthetic_experiment_only', sourceId: rule.sourceId, ruleText: rule.ruleText });
    expect(EMPIRICAL_CANCELLATION_TOOLS.map((tool) => tool.name)).toEqual(['domain.describe', 'domain.evaluate']);
    expect(EMPIRICAL_CANCELLATION_TOOLS.every((tool) => tool.readOnly)).toBe(true);
    expect(executeEmpiricalCancellationTool('domain.commit', {})).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_TOOL' } });
    expect(describeEmpiricalCancellation({ domain: 'synthetic-cancellation', version: 'wrong' })).toMatchObject({ status: 'error', error: { code: 'VERSION_MISMATCH' } });
  });
  it('supplies runner-compatible tools with explicit cancellation', async () => {
    const controller = new AbortController();
    const call = { id: 'call-1', name: 'domain.evaluate', arguments: request(base) };
    expect(await EMPIRICAL_CANCELLATION_TOOL_EXECUTOR.execute(call, { signal: controller.signal })).toMatchObject({ decision: 'half', value: '1666' });
    controller.abort();
    expect(await EMPIRICAL_CANCELLATION_TOOL_EXECUTOR.execute(call, { signal: controller.signal })).toMatchObject({ status: 'error', error: { code: 'ABORTED' } });
  });
});
