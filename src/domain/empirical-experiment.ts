/**
 * Transport-free paired experiment: the model chooses its own tools and inputs.
 * No provider, credentials, retrieval, oracle call targets, or network defaults.
 * Scripted adapters test plumbing only; they are not evidence of LLM accuracy.
 */
import { deepFreeze, isPlainObject, parseJsonValue, type JsonObject, type JsonPrimitive, type JsonValue } from './decision-context';

export const EMPIRICAL_PROTOCOL_VERSION = 'empirical-experiment-v1' as const;
export type EmpiricalCondition = 'natural_language' | 'executable_rules';
export interface EmpiricalCase {
  readonly id: string;
  readonly question: string;
  readonly facts: JsonObject;
  readonly ruleText: string;
  readonly corpusVersion: string;
  readonly followupQuestions?: readonly string[];
}
export interface EmpiricalExperimentConfig {
  readonly id: string;
  readonly model: { readonly provider: string; readonly model: string; readonly revision?: string };
  readonly settings: JsonObject;
  /** Public output vocabulary/meanings, identical in both conditions. No gold. */
  readonly answerSchema: JsonObject;
  readonly seeds: readonly number[];
  readonly maxModelTurns: number;
  readonly maxToolCalls: number;
  readonly callTimeoutMs: number;
}
export interface EmpiricalAnswer {
  readonly decision: string | null;
  readonly abstain: boolean;
  /** Use an exact decimal string where the domain requires exact quantities. */
  readonly value?: JsonPrimitive;
}
export interface EmpiricalTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface EmpiricalToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}
export type EmpiricalModelResponse = (
  | { readonly kind: 'final'; readonly answer: EmpiricalAnswer; readonly prose: string }
  | { readonly kind: 'tool_calls'; readonly calls: readonly EmpiricalToolCall[]; readonly prose?: string }
) & { readonly usage?: EmpiricalTokenUsage };
export interface EmpiricalToolSchema {
  readonly name: 'domain.describe' | 'domain.evaluate';
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly readOnly: true;
}
export type EmpiricalMessage =
  | { readonly role: 'user'; readonly question: string }
  | { readonly role: 'assistant'; readonly response: EmpiricalModelResponse }
  | { readonly role: 'tool'; readonly callId: string; readonly name: string; readonly result: JsonValue };
export interface EmpiricalModelRequest {
  readonly protocolVersion: typeof EMPIRICAL_PROTOCOL_VERSION;
  readonly model: EmpiricalExperimentConfig['model'];
  readonly settings: JsonObject;
  readonly seed: number;
  readonly instruction: string;
  readonly answerSchema: JsonObject;
  readonly input: Pick<EmpiricalCase, 'question' | 'facts' | 'ruleText'>;
  readonly tools: readonly EmpiricalToolSchema[];
  readonly messages: readonly EmpiricalMessage[];
}
export interface EmpiricalModelAdapter {
  /** Stateless per request: do not carry conversations or tools between episodes.
   * Return normalized JSON, retaining all final prose. Honor signal and disclose
   * unsupported seed/settings in the adapter's implementation, never silently.
   * Unknown permits recording and counting malformed provider responses. */
  complete(request: EmpiricalModelRequest, context: { readonly signal: AbortSignal }): Promise<unknown>;
}
export interface EmpiricalTools {
  readonly schemas: readonly EmpiricalToolSchema[];
  /** Validate arguments against the advertised schema, without filling missing
   * facts or correcting model choices. Execute only the pinned corpus version.
   * Tool-declared errors may be returned as JSON for model-directed recovery;
   * thrown errors are terminal infrastructure failures. Honor signal. */
  execute(call: EmpiricalToolCall, context: { readonly signal: AbortSignal }): Promise<unknown>;
}
export type EmpiricalEpisodeStatus = 'answered' | 'abstained' | 'missing' | 'invalid' | 'timeout' | 'steps_exhausted' | 'model_error' | 'tool_error';
export interface EmpiricalTrialMetadata {
  readonly trialId: string;
  readonly experimentId: string;
  readonly caseId: string;
  readonly questionCount: number;
  readonly corpusVersion: string;
  readonly condition: EmpiricalCondition;
  readonly seed: number;
  readonly model: EmpiricalExperimentConfig['model'];
  readonly settings: JsonObject;
}
export type EmpiricalTraceEvent =
  | { readonly type: 'model'; readonly request: EmpiricalModelRequest; readonly response: JsonValue; readonly latencyMs: number; readonly error?: string }
  | { readonly type: 'tool'; readonly call: EmpiricalToolCall; readonly response: JsonValue; readonly latencyMs: number; readonly executed: boolean; readonly error?: string };
export interface EmpiricalEpisode {
  readonly metadata: EmpiricalTrialMetadata;
  readonly status: EmpiricalEpisodeStatus;
  readonly reason?: string;
  readonly answer?: EmpiricalAnswer;
  readonly prose?: string;
  readonly answers: readonly { readonly questionIndex: number; readonly answer: EmpiricalAnswer; readonly prose: string }[];
  readonly trace: readonly EmpiricalTraceEvent[];
  readonly metrics: {
    readonly latencyMs: number;
    readonly modelCalls: number;
    readonly requestedToolCalls: number;
    readonly executedToolCalls: number;
    /** Sum of reported usage only; never impute zero for an unreported call. */
    readonly reportedTokens: EmpiricalTokenUsage;
    readonly usageReportedCalls: number;
  };
}
export interface EmpiricalExperiment {
  readonly protocolVersion: typeof EMPIRICAL_PROTOCOL_VERSION;
  readonly config: EmpiricalExperimentConfig;
  readonly plan: readonly EmpiricalTrialMetadata[];
  readonly episodes: readonly EmpiricalEpisode[];
}

const INSTRUCTION = '与えられた質問・事実・日本語ルールに基づいて回答してください。事実を補わず、結論を確定できない場合は abstain=true、decision=null としてください。利用可能なツールは必要に応じて自分で選び、引数も自分で組み立ててください。answerSchema に公開された語彙と意味に従い、最終回答は kind="final"、answer={decision:string|null,abstain:boolean,value?:JSON scalar} と説明文 prose:string を返してください。数値の正確性が必要なら value に十進文字列を使ってください。ツールを呼ぶ場合は kind="tool_calls"、calls=[{id,name,arguments}] を返してください。';
const TOOL_NAMES = new Set(['domain.describe', 'domain.evaluate']);
const snapshot = <T>(value: T): T => parseJsonValue(value, '$') as T;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const scalar = (value: unknown): value is JsonPrimitive => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
function isUsage(value: unknown): value is EmpiricalTokenUsage {
  return isPlainObject(value) && onlyKeys(value, ['inputTokens', 'outputTokens'])
    && nonnegativeInteger(value.inputTokens) && nonnegativeInteger(value.outputTokens);
}
function isAnswer(value: unknown): value is EmpiricalAnswer {
  return isPlainObject(value) && onlyKeys(value, ['decision', 'abstain', 'value']) && typeof value.abstain === 'boolean'
    && (value.abstain ? value.decision === null : text(value.decision))
    && (!Object.hasOwn(value, 'value') || scalar(value.value));
}
function isResponse(value: unknown): value is EmpiricalModelResponse {
  if (!isPlainObject(value)) return false;
  if (value.usage !== undefined && !isUsage(value.usage)) return false;
  if (value.kind === 'final') return onlyKeys(value, ['kind', 'answer', 'prose', 'usage']) && isAnswer(value.answer) && typeof value.prose === 'string';
  if (value.kind !== 'tool_calls' || !onlyKeys(value, ['kind', 'calls', 'prose', 'usage']) || !Array.isArray(value.calls) || value.calls.length === 0
    || (value.prose !== undefined && typeof value.prose !== 'string')) return false;
  const ids = new Set<string>();
  return value.calls.every((call: unknown) => {
    if (!isPlainObject(call) || !onlyKeys(call, ['id', 'name', 'arguments']) || !text(call.id) || !text(call.name) || !isPlainObject(call.arguments) || ids.has(call.id)) return false;
    ids.add(call.id);
    return true;
  });
}
class CallTimeout extends Error {}
async function boundedCall(call: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => call(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new CallTimeout()); controller.abort(); }, timeoutMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function runEpisode(config: EmpiricalExperimentConfig, item: EmpiricalCase, metadata: EmpiricalTrialMetadata, adapter: EmpiricalModelAdapter, tools: EmpiricalTools): Promise<EmpiricalEpisode> {
  const started = Date.now();
  const trace: EmpiricalTraceEvent[] = [];
  const messages: EmpiricalMessage[] = [];
  const answers: { questionIndex: number; answer: EmpiricalAnswer; prose: string }[] = [];
  let questionIndex = 0;
  const seenCallIds = new Set<string>();
  let modelCalls = 0, requestedToolCalls = 0, executedToolCalls = 0, usageReportedCalls = 0, inputTokens = 0, outputTokens = 0;
  const finish = (status: EmpiricalEpisodeStatus, reason?: string, response?: Extract<EmpiricalModelResponse, { kind: 'final' }>): EmpiricalEpisode => snapshot({
    metadata, status, ...(reason === undefined ? {} : { reason }),
    ...(response === undefined ? {} : { answer: response.answer, prose: response.prose }), answers, trace,
    metrics: { latencyMs: Date.now() - started, modelCalls, requestedToolCalls, executedToolCalls, reportedTokens: { inputTokens, outputTokens }, usageReportedCalls },
  });
  for (let turn = 0; turn < config.maxModelTurns; turn += 1) {
    const request: EmpiricalModelRequest = snapshot({
      protocolVersion: EMPIRICAL_PROTOCOL_VERSION, model: config.model, settings: config.settings, seed: metadata.seed,
      instruction: INSTRUCTION, answerSchema: config.answerSchema,
      // Whitelist explicitly: even runtime callers passing gold fields cannot leak them.
      input: { question: item.question, facts: item.facts, ruleText: item.ruleText },
      tools: metadata.condition === 'executable_rules' ? tools.schemas : [], messages,
    });
    const modelStarted = Date.now();
    modelCalls += 1;
    let raw: unknown;
    try { raw = await boundedCall((signal) => adapter.complete(request, { signal }), config.callTimeoutMs); }
    catch (error) {
      const status = error instanceof CallTimeout ? 'timeout' : 'model_error';
      trace.push({ type: 'model', request, response: null, latencyMs: Date.now() - modelStarted, error: status });
      return finish(status, 'Model call did not complete.');
    }
    let response: JsonValue;
    try { response = raw === undefined ? null : snapshot(raw) as JsonValue; }
    catch {
      trace.push({ type: 'model', request, response: null, latencyMs: Date.now() - modelStarted, error: 'non_json_response' });
      return finish('invalid', 'Model response was not finite, acyclic JSON.');
    }
    trace.push({ type: 'model', request, response, latencyMs: Date.now() - modelStarted });
    if (response === null) return finish('missing', 'Model returned no response.');
    if (isPlainObject(response) && isUsage(response.usage)) {
      usageReportedCalls += 1;
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
    }
    if (!isResponse(response)) return finish('invalid', 'Model response did not match the protocol.');
    if (response.kind === 'final') {
      answers.push({ questionIndex, answer: response.answer, prose: response.prose });
      const followup = item.followupQuestions?.[questionIndex];
      if (followup === undefined) return finish(response.answer.abstain ? 'abstained' : 'answered', undefined, response);
      questionIndex += 1;
      messages.push({ role: 'assistant', response }, { role: 'user', question: followup });
      continue;
    }
    messages.push({ role: 'assistant', response });
    requestedToolCalls += response.calls.length;
    for (const call of response.calls) {
      let rejection: string | undefined;
      if (metadata.condition !== 'executable_rules') rejection = 'tools_not_available';
      else if (!TOOL_NAMES.has(call.name) || !tools.schemas.some((schema) => schema.name === call.name)) rejection = 'unsupported_tool';
      else if (seenCallIds.has(call.id)) rejection = 'duplicate_call_id';
      else if (executedToolCalls >= config.maxToolCalls) rejection = 'tool_budget_exhausted';
      if (rejection !== undefined) {
        trace.push({ type: 'tool', call, response: null, latencyMs: 0, executed: false, error: rejection });
        return finish(rejection === 'tool_budget_exhausted' ? 'steps_exhausted' : 'invalid', rejection);
      }
      seenCallIds.add(call.id);
      const toolStarted = Date.now();
      executedToolCalls += 1;
      let result: JsonValue;
      try { result = snapshot(await boundedCall((signal) => tools.execute(call, { signal }), config.callTimeoutMs)) as JsonValue; }
      catch (error) {
        const status = error instanceof CallTimeout ? 'timeout' : 'tool_error';
        trace.push({ type: 'tool', call, response: null, latencyMs: Date.now() - toolStarted, executed: true, error: status });
        return finish(status, 'Tool call did not return a JSON result.');
      }
      trace.push({ type: 'tool', call, response: result, latencyMs: Date.now() - toolStarted, executed: true });
      messages.push({ role: 'tool', callId: call.id, name: call.name, result });
    }
  }
  return finish('steps_exhausted', 'Model turn budget exhausted before a final answer.');
}

/** Each case/seed is paired, with alternating condition order and fresh history.
 * All configuration errors are rejected before the first adapter/executor call.
 * Cases may contain extra scorer-only fields; only explicit model inputs cross.
 */
export async function runEmpiricalExperiment(config: EmpiricalExperimentConfig, cases: readonly EmpiricalCase[], adapter: EmpiricalModelAdapter, tools: EmpiricalTools): Promise<EmpiricalExperiment> {
  const frozenConfig = snapshot(config);
  const frozenCases = snapshot(cases);
  const schemas = snapshot(tools.schemas);
  if (!text(config.id) || !isPlainObject(config.model) || !text(config.model.provider) || !text(config.model.model)
    || (config.model.revision !== undefined && !text(config.model.revision)) || !isPlainObject(config.settings) || !isPlainObject(config.answerSchema) || config.answerSchema.type !== 'object'
    || !Array.isArray(config.seeds) || config.seeds.length === 0 || config.seeds.some((seed) => !nonnegativeInteger(seed))
    || new Set(config.seeds).size !== config.seeds.length
    || !nonnegativeInteger(config.maxModelTurns) || config.maxModelTurns < 1
    || !nonnegativeInteger(config.maxToolCalls) || !nonnegativeInteger(config.callTimeoutMs) || config.callTimeoutMs < 1
    || config.callTimeoutMs > 2_147_483_647) throw new Error('Invalid empirical experiment configuration.');
  if (cases.length === 0 || new Set(cases.map((item) => item.id)).size !== cases.length
    || cases.some((item) => !text(item.id) || !text(item.question) || !text(item.ruleText) || !text(item.corpusVersion) || !isPlainObject(item.facts)
      || (item.followupQuestions !== undefined && (!Array.isArray(item.followupQuestions) || item.followupQuestions.some((question) => !text(question)))))) throw new Error('Invalid empirical cases.');
  if (schemas.length === 0 || new Set(schemas.map((schema) => schema.name)).size !== schemas.length
    || schemas.some((schema) => !TOOL_NAMES.has(schema.name) || schema.readOnly !== true || !text(schema.description) || !isPlainObject(schema.inputSchema))) throw new Error('Only read-only domain.describe/domain.evaluate schemas are permitted.');
  const plan: EmpiricalTrialMetadata[] = [];
  for (const [caseIndex, item] of frozenCases.entries()) {
    for (const [seedIndex, seed] of frozenConfig.seeds.entries()) {
      const conditions: EmpiricalCondition[] = (caseIndex + seedIndex) % 2 === 0 ? ['natural_language', 'executable_rules'] : ['executable_rules', 'natural_language'];
      for (const condition of conditions) plan.push(snapshot({
        trialId: JSON.stringify([config.id, item.id, seed, condition]), experimentId: config.id,
        caseId: item.id, questionCount: 1 + (item.followupQuestions?.length ?? 0), corpusVersion: item.corpusVersion, condition, seed, model: frozenConfig.model, settings: frozenConfig.settings,
      }));
    }
  }
  const episodes: EmpiricalEpisode[] = [];
  const byId = new Map(frozenCases.map((item) => [item.id, item]));
  const frozenTools = { schemas, execute: tools.execute.bind(tools) };
  for (const metadata of plan) episodes.push(await runEpisode(frozenConfig, byId.get(metadata.caseId)!, metadata, adapter, frozenTools));
  return deepFreeze({ protocolVersion: EMPIRICAL_PROTOCOL_VERSION, config: frozenConfig, plan, episodes });
}

export interface EmpiricalGold {
  readonly caseId: string;
  readonly answer: EmpiricalAnswer;
  /** All replies, including the initial answer; last entry must equal answer. */
  readonly turnAnswers?: readonly EmpiricalAnswer[];
}
export interface EmpiricalScore {
  readonly trialId: string;
  readonly condition: EmpiricalCondition;
  readonly episodeStatus: EmpiricalEpisodeStatus | 'not_recorded';
  /** Last reply only; cannot establish conversation-level stability. */
  readonly structuredMatch: boolean;
  readonly turnStructuredMatches: readonly boolean[] | null;
  /** Null means multi-turn gold was not supplied, so drift is unscored. */
  readonly conversationStructuredMatch: boolean | null;
  /** Matching the structured decision cannot establish prose correctness. */
  readonly fullAnswerReview: 'pending';
}
function sameAnswer(expected: EmpiricalAnswer, observed: EmpiricalAnswer | undefined): boolean {
  return observed !== undefined && isAnswer(observed)
    && expected.decision === observed.decision && expected.abstain === observed.abstain
    && Object.hasOwn(expected, 'value') === Object.hasOwn(observed, 'value')
    && expected.value === observed.value;
}
/** Scoring never calls the model. Errors, abstentions and missing episodes remain
 * in the planned denominator. Expected abstention can match structured gold.
 * Human/blinded prose review and statistical inference belong in a later layer.
 */
export function scoreEmpiricalExperiment(experiment: EmpiricalExperiment, gold: readonly EmpiricalGold[]): {
  readonly scores: readonly EmpiricalScore[];
  readonly byCondition: Readonly<Record<EmpiricalCondition, { readonly planned: number; readonly structuredMatches: number; readonly structuredAccuracy: number }>>;
} {
  if (gold.some((item) => !text(item.caseId) || !isAnswer(item.answer)
    || (item.turnAnswers !== undefined && (!Array.isArray(item.turnAnswers) || item.turnAnswers.length === 0
      || item.turnAnswers.some((answer) => !isAnswer(answer)) || !sameAnswer(item.answer, item.turnAnswers.at(-1))))) || new Set(gold.map((item) => item.caseId)).size !== gold.length) throw new Error('Invalid or duplicate empirical gold.');
  const answers = new Map(gold.map((item) => [item.caseId, snapshot(item)]));
  const episodes = new Map(experiment.episodes.map((episode) => [episode.metadata.trialId, episode]));
  if (episodes.size !== experiment.episodes.length || new Set(experiment.plan.map((item) => item.trialId)).size !== experiment.plan.length) throw new Error('Duplicate empirical trial IDs.');
  const byCondition = { natural_language: { planned: 0, structuredMatches: 0, structuredAccuracy: 0 }, executable_rules: { planned: 0, structuredMatches: 0, structuredAccuracy: 0 } };
  const scores = experiment.plan.map((metadata): EmpiricalScore => {
    const expected = answers.get(metadata.caseId);
    if (expected === undefined) throw new Error(`Missing gold for case ${metadata.caseId}.`);
    const episode = episodes.get(metadata.trialId);
    const completed = episode?.status === 'answered' || episode?.status === 'abstained';
    const structuredMatch = completed && sameAnswer(expected.answer, episode?.answer);
    const turnGold = expected.turnAnswers ?? (metadata.questionCount === 1 ? [expected.answer] : undefined);
    if (turnGold !== undefined && turnGold.length !== metadata.questionCount) throw new Error(`Turn gold length does not match case ${metadata.caseId}.`);
    const turnStructuredMatches = turnGold?.map((answer, index) => sameAnswer(answer, episode?.answers[index]?.answer)) ?? null;
    const conversationStructuredMatch = turnStructuredMatches === null ? null
      : completed && episode?.answers.length === metadata.questionCount && turnStructuredMatches.every(Boolean);
    const summary = byCondition[metadata.condition];
    summary.planned += 1;
    summary.structuredMatches += Number(structuredMatch);
    return { trialId: metadata.trialId, condition: metadata.condition, episodeStatus: episode?.status ?? 'not_recorded', structuredMatch, turnStructuredMatches, conversationStructuredMatch, fullAnswerReview: 'pending' };
  });
  for (const summary of Object.values(byCondition)) summary.structuredAccuracy = summary.planned === 0 ? 0 : summary.structuredMatches / summary.planned;
  return deepFreeze({ scores, byCondition });
}
