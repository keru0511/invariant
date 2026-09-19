/**
 * Offline evaluation harness primitives.
 *
 * This module is deliberately transport-free. A model implementation is
 * supplied through EvaluationModel, while tests can use RecordedResponseSource
 * to replay responses without credentials, time, or network access.
 */

export const EVALUATION_FIXTURE_VERSION = 'evaluation-v0' as const;
export const TRIAL_RECORD_VERSION = 'trial-v0' as const;
export const INVARIANT_TOOL_REQUEST_VERSION = 'invariant-tool-request-v0' as const;
export const INVARIANT_TOOL_RESULT_VERSION = 'invariant-tool-result-v0' as const;
export const INVARIANT_TOOL_NAME = 'invariant.context' as const;

export const EVALUATION_CASE_FAMILIES = [
  'exception',
  'missing-fact',
  'threshold',
  'long-context-constraint',
  'recommendation-drift',
] as const;

export type EvaluationCaseFamily = (typeof EVALUATION_CASE_FAMILIES)[number];
export type AdapterKind = 'llm-only' | 'llm-invariant';
export type EpisodeStatus = 'completed' | 'missing' | 'timeout';
export type ScoreLabel = 'correct' | 'wrong' | 'unknown' | 'invented' | 'invalid';

export interface EvaluationExpectedAnswer {
  readonly answer: string | null;
  readonly requiredFacts: readonly string[];
  readonly requiredConstraints: readonly string[];
}

export interface EvaluationFixture {
  readonly version: typeof EVALUATION_FIXTURE_VERSION;
  readonly id: string;
  readonly family: EvaluationCaseFamily;
  readonly prompt: string;
  readonly knownFacts: readonly string[];
  readonly knownConstraints: readonly string[];
  readonly expected: EvaluationExpectedAnswer;
}

/** The only fixture data that may cross the model boundary. */
export interface ModelVisibleFixture {
  readonly version: typeof EVALUATION_FIXTURE_VERSION;
  readonly id: string;
  readonly family: EvaluationCaseFamily;
  readonly prompt: string;
}

export interface InvariantToolRequest {
  readonly version: typeof INVARIANT_TOOL_REQUEST_VERSION;
  readonly tool: typeof INVARIANT_TOOL_NAME;
  readonly fixtureId: string;
  readonly fixtureVersion: typeof EVALUATION_FIXTURE_VERSION;
  readonly prompt: string;
}

export interface InvariantToolResult {
  readonly version: typeof INVARIANT_TOOL_RESULT_VERSION;
  readonly knownFacts: readonly string[];
  readonly knownConstraints: readonly string[];
}

/** Injectable boundary for recorded, mock, or live Invariant tool clients. */
export interface InvariantToolClient {
  getContext?(request: InvariantToolRequest): Promise<InvariantToolResult>;
  evaluate?(request: DomainEvaluateRequest): Promise<unknown>;
  takeLastCall?(): InvariantToolCapture | null;
}

/** Explicit #14 domain.evaluate request used by credential-backed evaluation. */
export interface DomainEvaluateRequest {
  readonly workspace: string;
  readonly domain: string;
  readonly version: string;
  readonly function: string;
  readonly args: unknown;
}

export interface InvariantToolCapture {
  readonly request: DomainEvaluateRequest;
  readonly response: unknown;
}

export interface EvaluationRunOptions {
  /** Injected only by the live runner; no network is implied by this type. */
  readonly invariantToolClient: InvariantToolClient;
  /** Builds an explicit domain.evaluate request without copying fixture truth. */
  readonly invariantToolRequest: (fixture: EvaluationFixture) => DomainEvaluateRequest;
}

export interface RedactedInvariantToolEvidence {
  readonly request: {
    readonly version: typeof INVARIANT_TOOL_REQUEST_VERSION;
    readonly tool: typeof INVARIANT_TOOL_NAME;
    readonly fixtureId: string;
    readonly prompt: '[REDACTED]';
  };
  readonly response: {
    readonly version: typeof INVARIANT_TOOL_RESULT_VERSION;
    readonly knownFacts: '[REDACTED]';
    readonly knownConstraints: '[REDACTED]';
    readonly knownFactsCount: number;
    readonly knownConstraintsCount: number;
  };
}

export interface EvaluationResponse {
  readonly status: 'completed';
  readonly answer: string | null;
  readonly facts?: readonly string[];
  readonly constraints?: readonly string[];
}

export interface EpisodeResponse {
  readonly status: 'missing' | 'timeout';
  readonly reason?: string;
}

export type RawEvaluationResponse = EvaluationResponse | EpisodeResponse;

export interface ScoreResult {
  readonly label: ScoreLabel;
  readonly points: -1 | 0 | 1;
  readonly passed: boolean;
  readonly episodeStatus: EpisodeStatus;
  readonly reason: string;
  readonly expectedAnswer: string | null;
  readonly observedAnswer?: string | null;
}

export interface TrialRecord {
  readonly version: typeof TRIAL_RECORD_VERSION;
  readonly trialId: string;
  readonly fixtureId: string;
  readonly fixtureVersion: typeof EVALUATION_FIXTURE_VERSION;
  readonly adapter: AdapterKind;
  readonly episode: {
    readonly status: EpisodeStatus;
    readonly reason?: string;
  };
  readonly response: unknown;
  readonly score: ScoreResult;
  readonly invariantToolEvidence?: RedactedInvariantToolEvidence;
}

export interface ModelRequest {
  /** Deliberately excludes knownFacts, knownConstraints, and expected. */
  readonly fixture: ModelVisibleFixture;
  readonly adapter: AdapterKind;
  readonly prompt: string;
  /** Context returned by InvariantToolClient, never read from the scorer fixture. */
  readonly invariantContext?: Pick<InvariantToolResult, 'knownFacts' | 'knownConstraints'> | {
    readonly tool: 'domain.evaluate';
    readonly request: DomainEvaluateRequest;
    readonly response: unknown;
  };
}

export interface EvaluationModel {
  complete(request: ModelRequest): Promise<unknown>;
}

export interface EvaluationAdapter {
  readonly kind: AdapterKind;
  run(
    fixture: EvaluationFixture,
    model: EvaluationModel,
    invariantToolClient?: InvariantToolClient | EvaluationRunOptions,
  ): Promise<TrialRecord>;
}

const SCORE_POINTS: Readonly<Record<ScoreLabel, -1 | 0 | 1>> = {
  correct: 1,
  wrong: 0,
  unknown: 0,
  invented: -1,
  invalid: -1,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEvaluationRunOptions(value: InvariantToolClient | EvaluationRunOptions): value is EvaluationRunOptions {
  return isPlainObject(value) && 'invariantToolClient' in value && 'invariantToolRequest' in value;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function stringList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) {
    throw new Error(`${path} must be an array of non-empty strings.`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    throw new Error(`${path} must not contain duplicate values.`);
  }
  return result;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function visibleFixture(fixture: EvaluationFixture): ModelVisibleFixture {
  return {
    version: fixture.version,
    id: fixture.id,
    family: fixture.family,
    prompt: fixture.prompt,
  };
}

function validateInvariantToolResult(value: unknown): InvariantToolResult {
  if (!isPlainObject(value) || value.version !== INVARIANT_TOOL_RESULT_VERSION) {
    throw new Error('Invariant tool result has an unsupported version.');
  }
  return {
    version: INVARIANT_TOOL_RESULT_VERSION,
    knownFacts: stringList(value.knownFacts, 'invariantToolResult.knownFacts'),
    knownConstraints: stringList(value.knownConstraints, 'invariantToolResult.knownConstraints'),
  };
}

function redactedToolEvidence(request: InvariantToolRequest, result: InvariantToolResult): RedactedInvariantToolEvidence {
  return {
    request: {
      version: request.version,
      tool: request.tool,
      fixtureId: request.fixtureId,
      prompt: '[REDACTED]',
    },
    response: {
      version: result.version,
      knownFacts: '[REDACTED]',
      knownConstraints: '[REDACTED]',
      knownFactsCount: result.knownFacts.length,
      knownConstraintsCount: result.knownConstraints.length,
    },
  };
}

function invalidScore(fixture: EvaluationFixture, reason: string, status: EpisodeStatus = 'completed'): ScoreResult {
  return {
    label: 'invalid',
    points: SCORE_POINTS.invalid,
    passed: false,
    episodeStatus: status,
    reason,
    expectedAnswer: fixture.expected.answer,
  };
}

function invalidResponseReason(value: unknown): string | null {
  if (!isPlainObject(value)) return 'Response must be an object.';
  if (value.status !== 'completed' && value.status !== 'missing' && value.status !== 'timeout') {
    return 'Response status must be completed, missing, or timeout.';
  }
  if (value.status === 'completed') {
    if (!hasOwn(value, 'answer') || (value.answer !== null && !nonEmptyString(value.answer))) {
      return 'A completed response must contain a string answer or null.';
    }
    for (const key of ['facts', 'constraints'] as const) {
      if (hasOwn(value, key)) {
        try {
          stringList(value[key], `response.${key}`);
        } catch (error) {
          return error instanceof Error ? error.message : `Invalid response.${key}.`;
        }
      }
    }
  } else {
    if (hasOwn(value, 'answer') || hasOwn(value, 'facts') || hasOwn(value, 'constraints')) {
      return `${value.status} responses must not contain an answer or evidence.`;
    }
    if (hasOwn(value, 'reason') && !nonEmptyString(value.reason)) {
      return 'Episode reason must be a non-empty string.';
    }
  }
  return null;
}

function parsedEpisode(value: unknown): { readonly response: RawEvaluationResponse; readonly status: EpisodeStatus } | null {
  if (invalidResponseReason(value) !== null || !isPlainObject(value)) return null;
  if (value.status === 'completed') {
    return { response: value as unknown as EvaluationResponse, status: 'completed' };
  }
  const status = value.status as 'missing' | 'timeout';
  return { response: value as unknown as EpisodeResponse, status };
}

function unsupportedEvidence(fixture: EvaluationFixture, response: EvaluationResponse): string | null {
  const knownFacts = new Set(fixture.knownFacts);
  const knownConstraints = new Set(fixture.knownConstraints);
  for (const fact of response.facts ?? []) {
    if (!knownFacts.has(fact)) return `Response cites invented fact "${fact}".`;
  }
  for (const constraint of response.constraints ?? []) {
    if (!knownConstraints.has(constraint)) return `Response cites invented constraint "${constraint}".`;
  }
  return null;
}

/** Score a response using only the fixture's independent expected answer. */
export function scoreResponse(fixture: EvaluationFixture, value: unknown): ScoreResult {
  const invalidReason = invalidResponseReason(value);
  if (invalidReason !== null) return invalidScore(fixture, invalidReason);

  const episode = parsedEpisode(value);
  if (episode === null) return invalidScore(fixture, 'Response could not be parsed.');
  if (episode.status === 'missing' || episode.status === 'timeout') {
    const response = episode.response as EpisodeResponse;
    return {
      label: 'unknown',
      points: SCORE_POINTS.unknown,
      passed: false,
      episodeStatus: episode.status,
      reason: response.reason ?? `Model episode ended with ${episode.status}.`,
      expectedAnswer: fixture.expected.answer,
    };
  }

  const response = episode.response as EvaluationResponse;
  const inventedReason = unsupportedEvidence(fixture, response);
  if (inventedReason !== null) {
    return {
      label: 'invented',
      points: SCORE_POINTS.invented,
      passed: false,
      episodeStatus: 'completed',
      reason: inventedReason,
      expectedAnswer: fixture.expected.answer,
      observedAnswer: response.answer,
    };
  }
  const missingFacts = fixture.expected.requiredFacts.filter((fact) => !(response.facts ?? []).includes(fact));
  const missingConstraints = fixture.expected.requiredConstraints.filter(
    (constraint) => !(response.constraints ?? []).includes(constraint),
  );
  if (response.answer === null) {
    if (fixture.expected.answer === null && missingFacts.length === 0 && missingConstraints.length === 0) {
      return {
        label: 'correct',
        points: SCORE_POINTS.correct,
        passed: true,
        episodeStatus: 'completed',
        reason: 'Model correctly abstained because the independent expected answer is unknown.',
        expectedAnswer: null,
        observedAnswer: null,
      };
    }
    return {
      label: 'unknown',
      points: SCORE_POINTS.unknown,
      passed: false,
      episodeStatus: 'completed',
      reason: 'Model abstained without producing an answer.',
      expectedAnswer: fixture.expected.answer,
      observedAnswer: null,
    };
  }
  if (response.answer !== fixture.expected.answer) {
    return {
      label: 'wrong',
      points: SCORE_POINTS.wrong,
      passed: false,
      episodeStatus: 'completed',
      reason: `Expected answer "${fixture.expected.answer ?? 'unknown'}", got "${response.answer}".`,
      expectedAnswer: fixture.expected.answer,
      observedAnswer: response.answer,
    };
  }
  if (missingFacts.length > 0 || missingConstraints.length > 0) {
    const missing = [...missingFacts.map((fact) => `fact:${fact}`), ...missingConstraints.map((item) => `constraint:${item}`)];
    return {
      label: 'wrong',
      points: SCORE_POINTS.wrong,
      passed: false,
      episodeStatus: 'completed',
      reason: `Answer omitted required evidence: ${missing.join(', ')}.`,
      expectedAnswer: fixture.expected.answer,
      observedAnswer: response.answer,
    };
  }
  return {
    label: 'correct',
    points: SCORE_POINTS.correct,
    passed: true,
    episodeStatus: 'completed',
    reason: 'Answer and required evidence match the independent expected answer.',
    expectedAnswer: fixture.expected.answer,
    observedAnswer: response.answer,
  };
}

function validateFixture(fixture: EvaluationFixture): EvaluationFixture {
  if (fixture.version !== EVALUATION_FIXTURE_VERSION) throw new Error(`Unsupported fixture version: ${fixture.version}.`);
  if (!nonEmptyString(fixture.id) || !EVALUATION_CASE_FAMILIES.includes(fixture.family)) throw new Error(`Invalid fixture ${fixture.id}.`);
  if (!nonEmptyString(fixture.prompt)) throw new Error(`Fixture ${fixture.id} must have a prompt.`);
  const allFacts = stringList(fixture.knownFacts, `${fixture.id}.knownFacts`);
  const allConstraints = stringList(fixture.knownConstraints, `${fixture.id}.knownConstraints`);
  if (fixture.expected.answer !== null && !nonEmptyString(fixture.expected.answer)) throw new Error(`Invalid expected answer for ${fixture.id}.`);
  for (const value of fixture.expected.requiredFacts) if (!allFacts.includes(value)) throw new Error(`Unknown required fact ${value}.`);
  for (const value of fixture.expected.requiredConstraints) if (!allConstraints.includes(value)) throw new Error(`Unknown required constraint ${value}.`);
  return fixture;
}

function trialId(adapter: AdapterKind, fixture: EvaluationFixture): string {
  return `${TRIAL_RECORD_VERSION}:${adapter}:${fixture.id}`;
}

function makeTrialRecord(
  adapter: AdapterKind,
  fixture: EvaluationFixture,
  rawResponse: unknown,
  invariantToolEvidence?: RedactedInvariantToolEvidence,
): TrialRecord {
  const score = scoreResponse(fixture, rawResponse);
  const status = score.episodeStatus;
  const response = cloneJson(rawResponse);
  const episode = status === 'completed'
    ? { status }
    : { status, reason: isPlainObject(response) && nonEmptyString(response.reason) ? response.reason : score.reason };
  return Object.freeze({
    version: TRIAL_RECORD_VERSION,
    trialId: trialId(adapter, fixture),
    fixtureId: fixture.id,
    fixtureVersion: fixture.version,
    adapter,
    episode,
    response,
    score,
    ...(invariantToolEvidence === undefined ? {} : { invariantToolEvidence }),
  });
}

function createAdapter(kind: AdapterKind): EvaluationAdapter {
  return {
    kind,
    async run(fixtureInput, model, invariantToolClient) {
      const fixture = validateFixture(fixtureInput);
      let invariantContext: ModelRequest['invariantContext'];
      let invariantToolEvidence: RedactedInvariantToolEvidence | undefined;
      if (kind === 'llm-invariant') {
        if (invariantToolClient === undefined) {
          throw new Error('llm-invariant adapter requires an InvariantToolClient.');
        }
        const options = isEvaluationRunOptions(invariantToolClient) ? invariantToolClient : undefined;
        const client: InvariantToolClient = options === undefined
          ? invariantToolClient as InvariantToolClient
          : options.invariantToolClient;
        if (options !== undefined) {
          if (typeof client.evaluate !== 'function') {
            throw new Error('Live InvariantToolClient must implement evaluate.');
          }
          const toolRequest = options.invariantToolRequest(fixture);
          const toolResponse = await client.evaluate(toolRequest);
          invariantContext = {
            tool: 'domain.evaluate',
            request: toolRequest,
            response: toolResponse,
          };
        } else {
          const legacyClient = client as InvariantToolClient;
          if (typeof legacyClient.getContext !== 'function') {
            throw new Error('InvariantToolClient must implement getContext.');
          }
          const toolRequest: InvariantToolRequest = {
            version: INVARIANT_TOOL_REQUEST_VERSION,
            tool: INVARIANT_TOOL_NAME,
            fixtureId: fixture.id,
            fixtureVersion: fixture.version,
            prompt: fixture.prompt,
          };
          const toolResult = validateInvariantToolResult(await legacyClient.getContext(toolRequest));
          invariantContext = {
            knownFacts: [...toolResult.knownFacts],
            knownConstraints: [...toolResult.knownConstraints],
          };
          invariantToolEvidence = redactedToolEvidence(toolRequest, toolResult);
        }
      }
      const request: ModelRequest = {
        fixture: visibleFixture(fixture),
        adapter: kind,
        prompt: fixture.prompt,
        ...(invariantContext === undefined ? {} : { invariantContext }),
      };
      const rawResponse = await model.complete(request);
      return makeTrialRecord(kind, fixture, rawResponse, invariantToolEvidence);
    },
  };
}

/** Model-only adapter: the model receives only the fixture prompt. */
export const llmOnlyAdapter: EvaluationAdapter = createAdapter('llm-only');

/** Invariant adapter: the model receives explicit fact/constraint context. */
export const llmInvariantAdapter: EvaluationAdapter = createAdapter('llm-invariant');

export function runOfflineTrial(
  adapter: EvaluationAdapter,
  fixture: EvaluationFixture,
  model: EvaluationModel,
  invariantToolClient?: InvariantToolClient | EvaluationRunOptions,
): Promise<TrialRecord> {
  return adapter.run(fixture, model, invariantToolClient);
}

/** A deterministic, in-memory model source for tests and local replay. */
export class RecordedResponseSource implements EvaluationModel {
  private readonly responses: ReadonlyMap<string, unknown>;

  constructor(responses: Readonly<Record<string, unknown>>) {
    this.responses = new Map(Object.entries(responses).map(([key, value]) => [key, cloneJson(value)]));
  }

  async complete(request: ModelRequest): Promise<unknown> {
    const key = `${request.adapter}:${request.fixture.id}`;
    if (!this.responses.has(key)) return { status: 'missing', reason: `No recorded response for ${key}.` };
    return cloneJson(this.responses.get(key));
  }
}

/** Deterministic tool transcript for offline evaluation; it performs no I/O. */
export class RecordedInvariantToolClient implements InvariantToolClient {
  private readonly results: ReadonlyMap<string, InvariantToolResult>;

  constructor(results: Readonly<Record<string, InvariantToolResult>>) {
    this.results = new Map(Object.entries(results).map(([fixtureId, result]) => [
      fixtureId,
      validateInvariantToolResult(cloneJson(result)),
    ]));
  }

  async getContext(request: InvariantToolRequest): Promise<InvariantToolResult> {
    const result = this.results.get(request.fixtureId);
    if (result === undefined) {
      throw new Error(`No recorded Invariant tool result for ${request.fixtureId}.`);
    }
    return {
      version: result.version,
      knownFacts: [...result.knownFacts],
      knownConstraints: [...result.knownConstraints],
    };
  }
}

export function serializeTrialRecord(record: TrialRecord): string {
  return JSON.stringify(record);
}

export function deserializeTrialRecord(serialized: string): TrialRecord {
  const value: unknown = JSON.parse(serialized);
  if (!isPlainObject(value) || value.version !== TRIAL_RECORD_VERSION || !nonEmptyString(value.trialId) ||
      !nonEmptyString(value.fixtureId) || value.fixtureVersion !== EVALUATION_FIXTURE_VERSION ||
      (value.adapter !== 'llm-only' && value.adapter !== 'llm-invariant') || !isPlainObject(value.episode) ||
      !isPlainObject(value.score)) {
    throw new Error('Invalid trial record.');
  }
  return value as unknown as TrialRecord;
}

/** Re-score a saved trial with no adapter, clock, filesystem, or network call. */
export function rescoreTrial(record: TrialRecord, fixture: EvaluationFixture): TrialRecord {
  if (record.fixtureId !== fixture.id || record.fixtureVersion !== fixture.version) {
    throw new Error(`Trial ${record.trialId} does not match fixture ${fixture.id}.`);
  }
  const score = scoreResponse(fixture, record.response);
  return Object.freeze({ ...record, score, episode: score.episodeStatus === 'completed'
    ? { status: 'completed' }
    : { status: score.episodeStatus, reason: score.reason } });
}

export function rescoreSavedTrial(serialized: string, fixture: EvaluationFixture): string {
  return serializeTrialRecord(rescoreTrial(deserializeTrialRecord(serialized), fixture));
}

/** Stable representation useful for asserting deterministic offline replay. */
export function trialRecordFingerprint(record: TrialRecord): string {
  return stableJson(record);
}
