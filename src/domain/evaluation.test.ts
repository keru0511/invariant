import { describe, expect, it } from 'vitest';
import {
  fixtureById,
  OFFLINE_EVALUATION_FIXTURES,
} from './evaluation-fixtures';
import {
  llmInvariantAdapter,
  llmOnlyAdapter,
  RecordedResponseSource,
  rescoreSavedTrial,
  rescoreTrial,
  scoreResponse,
  serializeTrialRecord,
  deserializeTrialRecord,
  trialRecordFingerprint,
  type EvaluationFixture,
} from './evaluation';

const correctResponses: Readonly<Record<string, unknown>> = {
  'llm-only:evaluation-v0.exception': {
    status: 'completed', answer: 'deny', facts: ['exception.fraud-applies'], constraints: [],
  },
  'llm-only:evaluation-v0.missing-fact': {
    status: 'completed', answer: null, facts: ['account.active'], constraints: ['policy.country-required'],
  },
  'llm-only:evaluation-v0.threshold': {
    status: 'completed', answer: 'deny', facts: ['risk.score', 'risk.threshold', 'threshold.is-inclusive'], constraints: ['policy.high-risk-deny'],
  },
  'llm-only:evaluation-v0.long-context-constraint': {
    status: 'completed', answer: 'queue', facts: ['option.queue-available', 'data.classification.internal'], constraints: ['constraint.no-data-export', 'constraint.internal-only'],
  },
  'llm-only:evaluation-v0.recommendation-drift': {
    status: 'completed', answer: 'keep-queue', facts: ['recommendation.current-queue', 'objective.latency', 'evidence.no-new-latency-data'], constraints: ['constraint.no-unverified-switch'],
  },
};

function responseFor(fixture: EvaluationFixture, answer: string | null = fixture.expected.answer): Record<string, unknown> {
  return {
    status: 'completed',
    answer,
    facts: [...fixture.expected.requiredFacts],
    constraints: [...fixture.expected.requiredConstraints],
  };
}

describe('offline evaluation fixtures and scoring', () => {
  it('covers exactly the five versioned case families', () => {
    expect(OFFLINE_EVALUATION_FIXTURES.map((fixture) => fixture.family)).toEqual([
      'exception',
      'missing-fact',
      'threshold',
      'long-context-constraint',
      'recommendation-drift',
    ]);
    expect(new Set(OFFLINE_EVALUATION_FIXTURES.map((fixture) => fixture.id)).size).toBe(5);
  });

  it('scores correct, wrong, unknown, invented, and invalid responses predictably', () => {
    const threshold = fixtureById('evaluation-v0.threshold');
    expect(scoreResponse(threshold, responseFor(threshold))).toMatchObject({ label: 'correct', points: 1, passed: true });
    expect(scoreResponse(threshold, responseFor(threshold, 'allow'))).toMatchObject({ label: 'wrong', points: 0, passed: false });
    expect(scoreResponse(threshold, responseFor(threshold, null))).toMatchObject({ label: 'unknown', points: 0, passed: false });
    expect(scoreResponse(threshold, { ...responseFor(threshold), facts: ['fact.not-in-fixture'] })).toMatchObject({ label: 'invented', points: -1, passed: false });
    expect(scoreResponse(threshold, { status: 'completed', answer: 50 })).toMatchObject({ label: 'invalid', points: -1, passed: false });
  });

  it('treats a missing fact as a correct explicit abstention, but keeps missing and timeout episodes distinct', () => {
    const fixture = fixtureById('evaluation-v0.missing-fact');
    expect(scoreResponse(fixture, responseFor(fixture))).toMatchObject({ label: 'correct', passed: true, episodeStatus: 'completed' });
    expect(scoreResponse(fixture, { status: 'missing', reason: 'provider omitted the response' })).toMatchObject({
      label: 'unknown', points: 0, passed: false, episodeStatus: 'missing', reason: 'provider omitted the response',
    });
    expect(scoreResponse(fixture, { status: 'timeout', reason: 'recorded deadline exceeded' })).toMatchObject({
      label: 'unknown', points: 0, passed: false, episodeStatus: 'timeout', reason: 'recorded deadline exceeded',
    });
  });

  it('marks omitted long-context constraints as wrong and unsupported evidence as invented', () => {
    const fixture = fixtureById('evaluation-v0.long-context-constraint');
    expect(scoreResponse(fixture, {
      ...responseFor(fixture), constraints: ['constraint.no-data-export'],
    })).toMatchObject({ label: 'wrong', reason: expect.stringContaining('constraint.internal-only') });
    expect(scoreResponse(fixture, {
      ...responseFor(fixture), constraints: ['constraint.no-data-export', 'constraint.newly-invented'],
    })).toMatchObject({ label: 'invented' });
  });

  it('runs both adapter interfaces entirely from recorded responses', async () => {
    const source = new RecordedResponseSource(correctResponses);
    const onlyTrial = await llmOnlyAdapter.run(fixtureById('evaluation-v0.threshold'), source);
    expect(onlyTrial.score).toMatchObject({ label: 'correct', passed: true });

    let sawInvariantContext = false;
    const invariantTrial = await llmInvariantAdapter.run(fixtureById('evaluation-v0.recommendation-drift'), {
      async complete(request) {
        sawInvariantContext = request.invariantContext !== undefined;
        return responseFor(request.fixture);
      },
    });
    expect(sawInvariantContext).toBe(true);
    expect(invariantTrial.score).toMatchObject({ label: 'correct', passed: true });
  });

  it('runs one recorded correct response through every case family', async () => {
    const source = new RecordedResponseSource(correctResponses);
    for (const fixture of OFFLINE_EVALUATION_FIXTURES) {
      const trial = await llmOnlyAdapter.run(fixture, source);
      expect(trial.score, fixture.id).toMatchObject({ label: 'correct', passed: true });
    }
  });

  it('records missing responses from the replay source instead of calling a live model', async () => {
    const trial = await llmOnlyAdapter.run(fixtureById('evaluation-v0.exception'), new RecordedResponseSource({}));
    expect(trial.episode).toMatchObject({ status: 'missing' });
    expect(trial.score).toMatchObject({ label: 'unknown', episodeStatus: 'missing' });
  });

  it('saves, reloads, and deterministically re-scores without a model call', async () => {
    const fixture = fixtureById('evaluation-v0.recommendation-drift');
    const trial = await llmOnlyAdapter.run(fixture, new RecordedResponseSource({
      [`llm-only:${fixture.id}`]: responseFor(fixture, 'switch-to-direct'),
    }));
    const saved = serializeTrialRecord(trial);
    const reloaded = deserializeTrialRecord(saved);
    const first = rescoreTrial(reloaded, fixture);
    const second = rescoreSavedTrial(saved, fixture);

    expect(first.score).toMatchObject({ label: 'wrong', passed: false });
    expect(second).toBe(serializeTrialRecord(first));
    expect(trialRecordFingerprint(first)).toBe(trialRecordFingerprint(deserializeTrialRecord(second)));
  });

  it('does not use fetch or other network calls during offline scoring', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('network must not be called'); }) as typeof fetch;
    try {
      const fixture = fixtureById('evaluation-v0.exception');
      expect(scoreResponse(fixture, responseFor(fixture)).label).toBe('correct');
      expect(rescoreTrial({
        version: 'trial-v0', trialId: 'trial-v0:llm-only:evaluation-v0.exception', fixtureId: fixture.id,
        fixtureVersion: fixture.version, adapter: 'llm-only', episode: { status: 'completed' },
        response: responseFor(fixture), score: scoreResponse(fixture, responseFor(fixture)),
      }, fixture).score.label).toBe('correct');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
