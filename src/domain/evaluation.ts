/**
 * Offline evaluation harness primitives.
 *
 * This module is deliberately transport-free. A model implementation is
 * supplied through EvaluationModel, while tests can use RecordedResponseSource
 * to replay responses without credentials, time, or network access.
 */

export const EVALUATION_FIXTURE_VERSION = 'evaluation-v0' as const;
export const TRIAL_RECORD_VERSION = 'trial-v0' as const;

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
}

export interface ModelRequest {
  readonly fixture: EvaluationFixture;
  readonly adapter: AdapterKind;
  readonly prompt: string;
  readonly invariantContext?: {
    readonly knownFacts: readonly string[];
    readonly knownConstraints: readonly string[];
  };
}

export interface EvaluationModel {
  complete(request: ModelRequest): Promise<unknown>;
}

export interface EvaluationAdapter {
  readonly kind: AdapterKind;
  run(fixture: EvaluationFixture, model: EvaluationModel): Promise<TrialRecord>;
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

function makeTrialRecord(adapter: AdapterKind, fixture: EvaluationFixture, rawResponse: unknown): TrialRecord {
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
  });
}

function createAdapter(kind: AdapterKind): EvaluationAdapter {
  return {
    kind,
    async run(fixtureInput, model) {
      const fixture = validateFixture(fixtureInput);
      const request: ModelRequest = {
        fixture,
        adapter: kind,
        prompt: fixture.prompt,
        ...(kind === 'llm-invariant'
          ? { invariantContext: { knownFacts: fixture.knownFacts, knownConstraints: fixture.knownConstraints } }
          : {}),
      };
      const rawResponse = await model.complete(request);
      return makeTrialRecord(kind, fixture, rawResponse);
    },
  };
}

/** Model-only adapter: the model receives only the fixture prompt. */
export const llmOnlyAdapter: EvaluationAdapter = createAdapter('llm-only');

/** Invariant adapter: the model receives explicit fact/constraint context. */
export const llmInvariantAdapter: EvaluationAdapter = createAdapter('llm-invariant');

export function runOfflineTrial(adapter: EvaluationAdapter, fixture: EvaluationFixture, model: EvaluationModel): Promise<TrialRecord> {
  return adapter.run(fixture, model);
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
