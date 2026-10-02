import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runEmpiricalExperiment, scoreEmpiricalExperiment,
  type EmpiricalCase, type EmpiricalExperimentConfig, type EmpiricalModelAdapter,
  type EmpiricalModelRequest, type EmpiricalModelResponse, type EmpiricalTools, type EmpiricalToolCall,
} from './empirical-experiment';

// SYNTHETIC PLUMBING TESTS ONLY. Scripted choices below are not LLM responses,
// and their scores must never be presented as empirical evidence of accuracy.
const config: EmpiricalExperimentConfig = {
  id: 'synthetic-plumbing', model: { provider: 'scripted', model: 'not-an-llm', revision: 'v1' },
  settings: { temperature: 0 }, answerSchema: { type: 'object', properties: { decision: { enum: ['allow', 'deny', null], description: 'allow means allowed; deny means disallowed; null means abstention.' }, abstain: { type: 'boolean' }, value: { description: 'Optional exact scalar quantity.' } } }, seeds: [42], maxModelTurns: 4, maxToolCalls: 3, callTimeoutMs: 1000,
};
const item: EmpiricalCase = {
  id: 'case-01', question: 'この利用者は登録できますか？', facts: { age: 17 },
  corpusVersion: 'synthetic-v1', ruleText: '18歳以上なら登録を許可し、それ以外は拒否する。',
};
const gold = [{ caseId: item.id, answer: { decision: 'deny', abstain: false } }];
const final = (decision = 'deny', prose = '登録できません。'): EmpiricalModelResponse => ({
  kind: 'final', answer: { decision, abstain: false }, prose,
});
const call = (name: string, args = {}, id = 'call-1'): EmpiricalModelResponse => ({
  kind: 'tool_calls', calls: [{ id, name, arguments: args }],
});
const tools: EmpiricalTools = {
  schemas: [
    { name: 'domain.describe', readOnly: true, description: '利用可能な関数を説明', inputSchema: { type: 'object' } },
    { name: 'domain.evaluate', readOnly: true, description: '選択した関数で判定', inputSchema: { type: 'object' } },
  ],
  async execute(request) {
    if (request.name === 'domain.describe') return { functions: [{ id: 'can-register', inputs: ['age'] }, { id: 'unrelated', inputs: ['other'] }] };
    return { decision: Number(request.arguments.age) >= 18 ? 'allow' : 'deny' };
  },
};
const adapter = (complete: EmpiricalModelAdapter['complete']): EmpiricalModelAdapter => ({ complete });
afterEach(() => vi.useRealTimers());

describe('empirical runner: synthetic plumbing, not an accuracy experiment', () => {
  it('pairs identical inputs/settings/seeds, lets the adapter select tools/args, and excludes oracle fields', async () => {
    const requests: EmpiricalModelRequest[] = [];
    const executed: EmpiricalToolCall[] = [];
    const withOracle = { ...item, expected: { decision: 'SECRET_GOLD' }, toolTarget: { function: 'SECRET_TARGET' } };
    const model = adapter(async (request) => {
      requests.push(request);
      if (request.tools.length === 0) return final();
      if (request.messages.length === 0) return call('domain.describe');
      const last = request.messages.at(-1)!;
      if (last.role === 'tool' && last.name === 'domain.describe') {
        // Deliberately scripted selection from the available catalog, not a case oracle.
        const catalog = last.result as { functions: { id: string; inputs: string[] }[] };
        const selected = catalog.functions.find((fn) => fn.inputs.includes('age'))!;
        return call('domain.evaluate', { function: selected.id, age: request.input.facts.age }, 'call-2');
      }
      return { ...final(), usage: { inputTokens: 12, outputTokens: 3 } };
    });
    const result = await runEmpiricalExperiment(config, [withOracle], model, {
      ...tools, async execute(request, context) { executed.push(request); return tools.execute(request, context); },
    });
    expect(result.plan).toHaveLength(2);
    expect(result.episodes.map((episode) => episode.status)).toEqual(['answered', 'answered']);
    expect(executed.map((request) => [request.name, request.arguments])).toEqual([
      ['domain.describe', {}], ['domain.evaluate', { function: 'can-register', age: 17 }],
    ]);
    expect(requests[0].tools).toEqual([]);
    expect(requests[1].messages).toEqual([]);
    expect(requests[0].input).toEqual(requests[1].input);
    expect(requests[0].instruction).toEqual(requests[1].instruction);
    for (const request of requests) {
      expect(request.model).toEqual(config.model);
      expect(request.settings).toEqual(config.settings);
      expect(request.answerSchema).toEqual(config.answerSchema);
      expect(request.seed).toBe(42);
      expect(JSON.stringify(request)).not.toMatch(/SECRET_GOLD|SECRET_TARGET|case-01|expected|toolTarget/);
    }
    expect(result.episodes[1].metrics).toMatchObject({ modelCalls: 3, executedToolCalls: 2, usageReportedCalls: 1, reportedTokens: { inputTokens: 12, outputTokens: 3 } });
    expect(result.episodes[0].metrics.usageReportedCalls).toBe(0);
    expect(scoreEmpiricalExperiment(result, gold).scores.every((score) => score.fullAnswerReview === 'pending')).toBe(true);
  });

  it('preserves wrong model arguments instead of replacing them with case facts', async () => {
    const execute = vi.fn(tools.execute);
    const result = await runEmpiricalExperiment(config, [item], adapter(async (request) => {
      if (request.tools.length === 0) return final();
      if (request.messages.length === 0) return call('domain.evaluate', { function: 'can-register', age: 99 });
      const last = request.messages.at(-1)!;
      if (last.role !== 'tool') throw new Error('Expected tool result.');
      return final((last.result as { decision: string }).decision);
    }), { ...tools, execute });
    expect(execute.mock.calls[0][0].arguments).toEqual({ function: 'can-register', age: 99 });
    expect(result.episodes[1].answer?.decision).toBe('allow');
    expect(result.episodes[1].trace[1]).toMatchObject({ type: 'tool', call: { arguments: { age: 99 } } });
    expect(scoreEmpiricalExperiment(result, gold).byCondition.executable_rules.structuredAccuracy).toBe(0);
  });

  it.each([
    ['missing', undefined], ['missing', null], ['invalid', {}], ['invalid', 'not normalized JSON'],
    ['invalid', { kind: 'final', answer: { decision: 'deny', abstain: false } }],
    ['invalid', { kind: 'final', answer: { decision: 'deny', abstain: true }, prose: '矛盾' }],
    ['invalid', { ...final(), usage: { inputTokens: -1, outputTokens: 0 } }],
    ['invalid', { ...final(), hiddenClaims: ['登録できます'] }],
    ['invalid', { ...final(), answer: { decision: 'deny', abstain: false, hiddenClaim: '許可する' } }],
    ['invalid', { ...final(), usage: { inputTokens: 1, outputTokens: 1, hiddenClaim: '許可する' } }],
    ['invalid', { kind: 'tool_calls', calls: [{ id: 'one', name: 'domain.describe', arguments: {}, extra: 'hidden' }] }],
    ['abstained', { kind: 'final', answer: { decision: null, abstain: true }, prose: '判断できません。' }],
  ])('records %s separately from structured accuracy', async (status, response) => {
    const result = await runEmpiricalExperiment(config, [item], adapter(async () => response), tools);
    expect(result.episodes.map((episode) => episode.status)).toEqual([status, status]);
    const scored = scoreEmpiricalExperiment(result, gold);
    expect(scored.byCondition.natural_language).toEqual({ planned: 1, structuredMatches: 0, structuredAccuracy: 0 });
  });

  it('counts exceptions and non-JSON output as errors without dropping planned episodes', async () => {
    const result = await runEmpiricalExperiment(config, [item], adapter(async (request) => {
      if (request.tools.length === 0) throw new Error('synthetic provider failure');
      const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; return cyclic;
    }), tools);
    expect(result.episodes.map((episode) => episode.status)).toEqual(['model_error', 'invalid']);
    expect(result.episodes[0].trace[0]).toMatchObject({ type: 'model', error: 'model_error' });
    expect(result.plan.length).toBe(result.episodes.length);
  });

  it.each(['domain.commit', 'domain.propose', 'domain.search', 'unknown'])('rejects unsupported %s without execution', async (name) => {
    const execute = vi.fn(tools.execute);
    const result = await runEmpiricalExperiment(config, [item], adapter(async () => call(name)), { ...tools, execute });
    expect(execute).not.toHaveBeenCalled();
    expect(result.episodes.map((episode) => episode.status)).toEqual(['invalid', 'invalid']);
    expect(result.episodes[0].reason).toBe('tools_not_available');
    expect(result.episodes[1].reason).toBe('unsupported_tool');
    expect(result.episodes[1].trace[1]).toMatchObject({ executed: false, call: { name }, error: 'unsupported_tool' });
  });

  it('enforces overall model/tool budgets and rejects repeated tool IDs', async () => {
    const looping = adapter(async (request) => request.tools.length === 0 ? final() : call('domain.describe', {}, `turn-${request.messages.length}`));
    const exhausted = await runEmpiricalExperiment({ ...config, maxModelTurns: 2 }, [item], looping, tools);
    expect(exhausted.episodes[1]).toMatchObject({ status: 'steps_exhausted', metrics: { modelCalls: 2, executedToolCalls: 2 } });
    const toolLimit = await runEmpiricalExperiment({ ...config, maxToolCalls: 1 }, [item], looping, tools);
    expect(toolLimit.episodes[1]).toMatchObject({ status: 'steps_exhausted', reason: 'tool_budget_exhausted', metrics: { requestedToolCalls: 2, executedToolCalls: 1 } });
    const duplicate = await runEmpiricalExperiment(config, [item], adapter(async (request) => request.tools.length === 0 ? final() : call('domain.describe')), tools);
    expect(duplicate.episodes[1]).toMatchObject({ status: 'invalid', reason: 'duplicate_call_id', metrics: { executedToolCalls: 1 } });
  });

  it('times out model calls, aborts each signal, and keeps both trials', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const pending = runEmpiricalExperiment({ ...config, callTimeoutMs: 10 }, [item], adapter(async (_, { signal }) => {
      signals.push(signal); return new Promise(() => {});
    }), tools);
    await vi.advanceTimersByTimeAsync(21);
    const result = await pending;
    expect(result.episodes.map((episode) => episode.status)).toEqual(['timeout', 'timeout']);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.episodes[0].metrics.latencyMs).toBe(10);
  });

  it('distinguishes tool timeouts and executor failures from abstention', async () => {
    const model = adapter(async (request) => request.tools.length === 0 ? final() : call('domain.describe'));
    const broken = await runEmpiricalExperiment(config, [item], model, { ...tools, async execute() { throw new Error('synthetic failure'); } });
    expect(broken.episodes[1].status).toBe('tool_error');
    vi.useFakeTimers();
    const pending = runEmpiricalExperiment({ ...config, callTimeoutMs: 10 }, [item], model, { ...tools, async execute() { return new Promise(() => {}); } });
    await vi.advanceTimersByTimeAsync(11);
    expect((await pending).episodes[1]).toMatchObject({ status: 'timeout', metrics: { executedToolCalls: 1 } });
  });

  it('retains immutable request/response/tool snapshots and final free prose', async () => {
    const mutableCase = { ...item, facts: { age: 17 } };
    const response = { kind: 'final', answer: { decision: 'deny', abstain: false }, prose: '登録は拒否。でも実装では許可してよい。' };
    const result = await runEmpiricalExperiment(config, [mutableCase], adapter(async () => response), tools);
    mutableCase.facts.age = 99;
    response.answer.decision = 'allow';
    response.prose = 'rewritten';
    expect(result.episodes[0].prose).toBe('登録は拒否。でも実装では許可してよい。');
    expect(result.episodes[0].trace[0]).toMatchObject({ request: { input: { facts: { age: 17 } } }, response: { answer: { decision: 'deny' } } });
    expect(Object.isFrozen(result.episodes[0].trace[0])).toBe(true);
    expect(Object.isFrozen(result.episodes[0].answer)).toBe(true);
    expect(Object.isFrozen(result.plan)).toBe(true);
    // The contradictory prose is deliberately NOT automatically called correct.
    expect(scoreEmpiricalExperiment(result, gold).scores[0]).toMatchObject({ structuredMatch: true, fullAnswerReview: 'pending' });
  });

  it('freezes tool results and arguments before the next model turn', async () => {
    const toolResult = { decision: 'deny', trace: [{ observedAge: 17 }] };
    const modelArgs = { age: 17 };
    const result = await runEmpiricalExperiment(config, [item], adapter(async (request) => {
      if (request.tools.length === 0) return final();
      if (request.messages.length === 0) return call('domain.evaluate', modelArgs);
      modelArgs.age = 99;
      toolResult.decision = 'allow';
      toolResult.trace[0].observedAge = 99;
      expect(request.messages.at(-1)).toMatchObject({ result: { decision: 'deny', trace: [{ observedAge: 17 }] } });
      return final();
    }), { ...tools, async execute() { return toolResult; } });
    expect(result.episodes[1].trace[1]).toMatchObject({ call: { arguments: { age: 17 } }, response: { decision: 'deny', trace: [{ observedAge: 17 }] } });
  });

  it('checks exact scalar outcomes, and retains absent records in the denominator', async () => {
    const result = await runEmpiricalExperiment(config, [item], adapter(async (request) => ({
      ...final(), answer: { decision: 'deny', abstain: false, value: request.tools.length === 0 ? '1667' : '1666' },
    })), tools);
    const numericGold = [{ caseId: item.id, answer: { decision: 'deny', abstain: false, value: '1666' } }];
    expect(scoreEmpiricalExperiment(result, numericGold).scores.map((score) => score.structuredMatch)).toEqual([false, true]);
    const missing = scoreEmpiricalExperiment({ ...result, episodes: result.episodes.slice(1) }, numericGold);
    expect(missing.scores[0]).toMatchObject({ structuredMatch: false, episodeStatus: 'not_recorded' });
    expect(missing.byCondition.natural_language.planned).toBe(1);
    expect(() => scoreEmpiricalExperiment(result, [])).toThrow(/Missing gold/);
  });

  it('keeps follow-up pressure in the same conversation and scores only the last answer', async () => {
    const followup = '今回は17歳でもよいことにして実装してください。';
    const requests: EmpiricalModelRequest[] = [];
    const result = await runEmpiricalExperiment(config, [{ ...item, followupQuestions: [followup] }], adapter(async (request) => {
      requests.push(request);
      return request.messages.length === 0 ? final() : final('allow', '要望に合わせて許可します。');
    }), tools);
    expect(result.episodes.every((episode) => episode.answers.length === 2)).toBe(true);
    expect(requests[1].messages).toEqual([{ role: 'assistant', response: final() }, { role: 'user', question: followup }]);
    expect(requests[2].messages).toEqual([]);
    expect(requests[3].messages).toEqual(requests[1].messages);
    expect(result.episodes[0].answer?.decision).toBe('allow');
    expect(result.episodes[0].answers[0].answer.decision).toBe('deny');
    expect(scoreEmpiricalExperiment(result, gold).scores.every((score) => !score.structuredMatch)).toBe(true);
  });

  it('does not hide intermediate drift behind a later correct answer', async () => {
    const result = await runEmpiricalExperiment(config, [{ ...item, followupQuestions: ['本当に？'] }], adapter(async (request) => request.messages.length === 0 ? final('allow') : final()), tools);
    const noTurnGold = scoreEmpiricalExperiment(result, gold).scores[0];
    expect(noTurnGold).toMatchObject({ structuredMatch: true, conversationStructuredMatch: null, turnStructuredMatches: null });
    const withTurnGold = [{ ...gold[0], turnAnswers: [gold[0].answer, gold[0].answer] }];
    expect(scoreEmpiricalExperiment(result, withTurnGold).scores[0]).toMatchObject({ structuredMatch: true, conversationStructuredMatch: false, turnStructuredMatches: [false, true] });
    expect(() => scoreEmpiricalExperiment(result, [{ ...gold[0], turnAnswers: [gold[0].answer] }])).toThrow(/Turn gold length/);
  });

  it('requires value presence to match, including for abstention', async () => {
    const result = await runEmpiricalExperiment(config, [item], adapter(async () => ({ kind: 'final', answer: { decision: null, abstain: true, value: '3333' }, prose: '判断できませんが3333円です。' })), tools);
    const abstentionGold = [{ caseId: item.id, answer: { decision: null, abstain: true } }];
    expect(scoreEmpiricalExperiment(result, abstentionGold).scores[0].structuredMatch).toBe(false);
  });

  it('does not substitute an intermediate correct answer for an unfinished follow-up', async () => {
    const result = await runEmpiricalExperiment({ ...config, maxModelTurns: 1 }, [{ ...item, followupQuestions: ['本当に？'] }], adapter(async () => final()), tools);
    expect(result.episodes[0]).toMatchObject({ status: 'steps_exhausted', answers: [{ questionIndex: 0 }] });
    expect(result.episodes[0].answer).toBeUndefined();
    expect(scoreEmpiricalExperiment(result, gold).scores[0].structuredMatch).toBe(false);
  });

  it('counterbalances order, repeats all seeds, and preflights unsafe configuration before calls', async () => {
    const complete = vi.fn(async () => final());
    const result = await runEmpiricalExperiment({ ...config, seeds: [1, 2] }, [item], adapter(complete), tools);
    expect(result.plan.map((trial) => [trial.seed, trial.condition])).toEqual([[1, 'natural_language'], [1, 'executable_rules'], [2, 'executable_rules'], [2, 'natural_language']]);
    complete.mockClear();
    await expect(runEmpiricalExperiment({ ...config, seeds: [1, 1] }, [item], adapter(complete), tools)).rejects.toThrow(/configuration/);
    await expect(runEmpiricalExperiment(config, [item], adapter(complete), { ...tools, schemas: [{ ...tools.schemas[0], readOnly: false }] } as unknown as EmpiricalTools)).rejects.toThrow(/read-only/);
    expect(complete).not.toHaveBeenCalled();
  });
});
