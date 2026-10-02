import { describe, expect, it } from 'vitest';
import {
  fixtureById,
  OFFLINE_EVALUATION_FIXTURES,
} from './evaluation-fixtures';
import {
  INVARIANT_TOOL_NAME,
  INVARIANT_TOOL_REQUEST_VERSION,
  INVARIANT_TOOL_RESULT_VERSION,
  llmInvariantAdapter,
  llmOnlyAdapter,
  RecordedInvariantToolClient,
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

function toolResultFor(fixture: EvaluationFixture) {
  return {
    version: INVARIANT_TOOL_RESULT_VERSION,
    knownFacts: [...fixture.knownFacts],
    knownConstraints: [...fixture.knownConstraints],
  } as const;
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
    const fixture = fixtureById('evaluation-v0.recommendation-drift');
    const invariantTrial = await llmInvariantAdapter.run(fixtureById('evaluation-v0.recommendation-drift'), {
      async complete(request) {
        sawInvariantContext = request.invariantContext !== undefined;
        return responseFor(fixture);
      },
    }, new RecordedInvariantToolClient({ [fixture.id]: toolResultFor(fixture) }));
    expect(sawInvariantContext).toBe(true);
    expect(invariantTrial.score).toMatchObject({ label: 'correct', passed: true });
    expect(invariantTrial.invariantToolEvidence).toMatchObject({
      request: { tool: INVARIANT_TOOL_NAME, fixtureId: fixture.id, prompt: '[REDACTED]' },
      response: { knownFacts: '[REDACTED]', knownConstraints: '[REDACTED]' },
    });
  });

  it('calls the recorded Invariant tool and never injects hidden fixture truth into the model request', async () => {
    const base = fixtureById('evaluation-v0.threshold');
    const fixture: EvaluationFixture = {
      ...base,
      knownFacts: ['hidden.fact'],
      knownConstraints: ['hidden.constraint'],
      expected: { ...base.expected, requiredFacts: [], requiredConstraints: [] },
    };
    const toolCalls: unknown[] = [];
    let modelRequest: unknown;
    const toolClient = {
      async getContext(request: Parameters<RecordedInvariantToolClient['getContext']>[0]) {
        toolCalls.push(request);
        return {
          version: INVARIANT_TOOL_RESULT_VERSION,
          knownFacts: ['tool.fact'],
          knownConstraints: ['tool.constraint'],
        } as const;
      },
    };
    const trial = await llmInvariantAdapter.run(fixture, {
      async complete(request) {
        modelRequest = request;
        return { status: 'completed', answer: fixture.expected.answer, facts: [], constraints: [] };
      },
    }, toolClient);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      version: INVARIANT_TOOL_REQUEST_VERSION,
      tool: INVARIANT_TOOL_NAME,
      fixtureId: fixture.id,
      prompt: fixture.prompt,
    });
    expect(modelRequest).toMatchObject({
      fixture: { version: fixture.version, id: fixture.id, family: fixture.family, prompt: fixture.prompt },
      prompt: fixture.prompt,
      invariantContext: { knownFacts: ['tool.fact'], knownConstraints: ['tool.constraint'] },
    });
    expect(modelRequest).not.toHaveProperty('fixture.knownFacts');
    expect(JSON.stringify(modelRequest)).not.toContain('hidden.fact');
    expect(JSON.stringify(modelRequest)).not.toContain('hidden.constraint');
    expect(trial.invariantToolEvidence).toMatchObject({
      request: { prompt: '[REDACTED]' },
      response: {
        knownFacts: '[REDACTED]',
        knownConstraints: '[REDACTED]',
        knownFactsCount: 1,
        knownConstraintsCount: 1,
      },
    });
    expect(JSON.stringify(trial.invariantToolEvidence)).not.toContain('tool.fact');
    expect(JSON.stringify(trial.invariantToolEvidence)).not.toContain('hidden.fact');
    expect(trial.score).toMatchObject({ label: 'correct', passed: true });
  });

  it('requires an Invariant tool client for the invariant adapter', async () => {
    await expect(
      llmInvariantAdapter.run(fixtureById('evaluation-v0.threshold'), new RecordedResponseSource({})),
    ).rejects.toThrow('requires an InvariantToolClient');
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

  it('keeps the recorded Invariant tool path offline when fetch is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('network must not be called'); }) as typeof fetch;
    try {
      const fixture = fixtureById('evaluation-v0.exception');
      const trial = await llmInvariantAdapter.run(fixture, new RecordedResponseSource({}), new RecordedInvariantToolClient({
        [fixture.id]: toolResultFor(fixture),
      }));
      expect(trial.invariantToolEvidence?.response.knownFacts).toBe('[REDACTED]');
      expect(trial.episode.status).toBe('missing');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

it('does not mark a response with unscored extra claims as correct', () => {
  const fixture = fixtureById('evaluation-v0.threshold');
  expect(scoreResponse(fixture, { ...responseFor(fixture), explanation: 'An unsupported extra factual claim.' })).toMatchObject({ label: 'invalid', passed: false });
  expect(scoreResponse(fixture, { status: 'missing', hiddenAnswer: 'allow' })).toMatchObject({ label: 'invalid', passed: false });
});

describe('evaluation snapshot boundaries', () => {
  it('keeps the original expected answer when the caller changes the fixture during completion', async () => {
    const fixture = structuredClone(fixtureById('evaluation-v0.threshold'));
    const response = responseFor(fixture, 'allow');
    const record = await llmOnlyAdapter.run(fixture, { complete: async () => {
      (fixture.expected as { answer: string | null }).answer = 'allow';
      return response;
    } });
    expect(record.score).toMatchObject({ label: 'wrong', expectedAnswer: 'deny' });
    expect(Object.isFrozen(fixture)).toBe(false);
  });
  it('isolates tool requests, tool results, model requests, and recorded results', async () => {
    const fixture = fixtureById('evaluation-v0.threshold');
    const originalRequest = { workspace: 'w', domain: 'd', version: 'v1', function: 'refund', args: { order: { total: 150 } } };
    const originalResult = { status: 'resolved', decision: 'deny' };
    const record = await llmInvariantAdapter.run(fixture, { complete: async (request) => {
      originalResult.decision = 'allow';
      expect(request.invariantContext).toMatchObject({ request: { args: { order: { total: 150 } } }, response: { decision: 'deny' } });
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.invariantContext)).toBe(true);
      return responseFor(fixture);
    } }, { invariantToolRequest: () => originalRequest, invariantToolClient: { evaluate: async (request) => {
      originalRequest.args.order.total = 50;
      expect(Object.isFrozen(request)).toBe(true);
      return originalResult;
    } } });
    expect(Object.isFrozen(record.score)).toBe(true);
    expect(Object.isFrozen(record.response)).toBe(true);
    expect(Object.isFrozen(originalRequest)).toBe(false);
  });
});

it('scores the same immutable response snapshot that is recorded', async () => {
  const fixture = fixtureById('evaluation-v0.threshold');
  let reads = 0;
  const output = { ...responseFor(fixture), get answer() { return reads++ === 0 ? 'deny' : 'allow'; } };
  const record = await llmOnlyAdapter.run(fixture, { complete: async () => output });
  expect(reads).toBe(1);
  expect(record.response).toMatchObject({ answer: 'deny' });
  expect(record.score).toMatchObject({ label: 'correct', observedAnswer: 'deny' });
});

describe('offline saved record boundaries', () => {
  it.each(['points', 'label', 'passed', 'episode', 'evidence'])('rejects malformed %s instead of exposing it as a typed result', async (field) => {
    const fixture = fixtureById('evaluation-v0.threshold');
    const record = JSON.parse(serializeTrialRecord(await llmOnlyAdapter.run(fixture, { complete: async () => responseFor(fixture) })));
    if (field === 'points') record.score.points = 999;
    if (field === 'label') record.score.label = 'unregistered';
    if (field === 'passed') record.score.passed = 'yes';
    if (field === 'episode') record.episode.status = 'made-up';
    if (field === 'evidence') record.invariantToolEvidence = { request: { prompt: 'not redacted' }, response: {} };
    expect(() => deserializeTrialRecord(JSON.stringify(record))).toThrow();
  });
  it('keeps loaded and rescored evidence immutable without freezing the caller object', async () => {
    const fixture = fixtureById('evaluation-v0.threshold');
    const original = JSON.parse(serializeTrialRecord(await llmOnlyAdapter.run(fixture, { complete: async () => responseFor(fixture) })));
    const loaded = deserializeTrialRecord(JSON.stringify(original));
    expect(Object.isFrozen(loaded.response)).toBe(true);
    const rescored = rescoreTrial(original, fixture);
    expect(Object.isFrozen(rescored.score)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });
});
