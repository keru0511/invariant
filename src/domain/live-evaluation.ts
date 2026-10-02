import { compareCanonicalText } from './canonical-order';
import { parseJsonValue } from './decision-context';
/**
 * Credential-free orchestration, redaction, recording, and reporting for the
 * live v0 evaluation.  The provider is injected so normal CI remains offline.
 */

import {
  llmInvariantAdapter,
  llmOnlyAdapter,
  rescoreTrial,
  scoreResponse,
  isScoreResult,
  snapshotEvaluationFixture,
  EVALUATION_CASE_FAMILIES,
  EVALUATION_FIXTURE_VERSION,
  type AdapterKind,
  type EvaluationFixture,
  type EvaluationModel,
  type InvariantToolCapture,
  type InvariantToolClient,
  type DomainEvaluateRequest,
  type ScoreLabel,
  type ScoreResult,
  type TrialRecord,
} from "./evaluation";
import { OFFLINE_EVALUATION_FIXTURES } from "./evaluation-fixtures";

export const LIVE_EVALUATION_CONFIG_VERSION = "live-evaluation-v0" as const;
export const LIVE_TRIAL_RECORD_VERSION = "live-trial-v0" as const;
export const LIVE_REPORT_VERSION = "live-report-v0" as const;

export interface LiveCaseTarget {
  readonly domain: string;
  readonly version: string;
  readonly function: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface LiveEvaluationConfig {
  readonly version: typeof LIVE_EVALUATION_CONFIG_VERSION;
  readonly fixtureVersion: "evaluation-v0";
  readonly trialsPerCase: number;
  readonly outputDir: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly mcpUrl: string;
  readonly workspace: string;
  readonly domain: string;
  readonly domainVersion: string;
  readonly function: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly caseTargets: Readonly<Record<string, LiveCaseTarget>>;
  readonly timeoutMs: number;
}

const DEFAULT_LIVE_CASE_TARGETS: Readonly<Record<string, LiveCaseTarget>> = Object.freeze({
  "evaluation-v0.exception": { domain: "orders", version: "v1", function: "member-age", args: { user: { age: 17 } } },
  "evaluation-v0.missing-fact": { domain: "orders", version: "v1", function: "member-age", args: { user: { age: 21 } } },
  "evaluation-v0.threshold": { domain: "orders", version: "v1", function: "refund", args: { order: { status: "paid", total: 150 } } },
  "evaluation-v0.long-context-constraint": { domain: "orders", version: "v1", function: "account-review", args: { account: { state: "active", riskScore: 10, country: "JP" } } },
  "evaluation-v0.recommendation-drift": { domain: "orders", version: "v1", function: "refund", args: { order: { status: "paid", total: 50 } } },
});

export const DEFAULT_LIVE_EVALUATION_CONFIG: LiveEvaluationConfig = Object.freeze({
  version: LIVE_EVALUATION_CONFIG_VERSION,
  fixtureVersion: "evaluation-v0",
  trialsPerCase: 1,
  outputDir: "artifacts/live-evaluation",
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",
  mcpUrl: "http://localhost:8787/mcp",
  workspace: "workspace-a",
  domain: "orders",
  domainVersion: "v1",
  function: "member-age",
  args: { user: { age: 21 } },
  caseTargets: DEFAULT_LIVE_CASE_TARGETS,
  timeoutMs: 30_000,
});

export interface LiveEvaluationCliOptions {
  readonly configPath?: string;
  readonly trialsPerCase?: number;
  readonly outputDir?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly mcpUrl?: string;
  readonly workspace?: string;
  readonly domain?: string;
  readonly domainVersion?: string;
  readonly function?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly help: boolean;
}

export class LiveEvaluationConfigError extends Error {
  readonly code: "INVALID_ARGUMENT" | "INVALID_CONFIG" | "MISSING_CREDENTIALS";

  constructor(code: LiveEvaluationConfigError["code"], message: string) {
    super(message);
    this.name = "LiveEvaluationConfigError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", field + " must be a non-empty string.");
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", field + " must be a positive integer.");
  }
  return value;
}

function httpUrl(value: unknown, field: string): string {
  const candidate = text(value, field);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", field + " must be an absolute http(s) URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", field + " must be an http(s) URL without credentials.");
  }
  return candidate.replace(/\/+$/, "");
}

function jsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", field + " must be a JSON object.");
  }
  try { return parseJsonValue(value, field) as Readonly<Record<string, unknown>>; }
  catch { throw new LiveEvaluationConfigError('INVALID_CONFIG', field + ' must contain finite, acyclic JSON data.'); }
}

function caseTargets(value: unknown, field: string): Readonly<Record<string, LiveCaseTarget>> {
  if (!isRecord(value)) throw new LiveEvaluationConfigError("INVALID_CONFIG", field + " must be an object keyed by fixture ID.");
  const result: Record<string, LiveCaseTarget> = Object.create(null);
  for (const [fixtureId, target] of Object.entries(value)) {
    if (!isRecord(target)) throw new LiveEvaluationConfigError("INVALID_CONFIG", field + "." + fixtureId + " must be an object.");
    result[fixtureId] = Object.freeze({
      domain: text(target.domain, field + "." + fixtureId + ".domain"),
      version: text(target.version, field + "." + fixtureId + ".version"),
      function: text(target.function, field + "." + fixtureId + ".function"),
      args: jsonObject(target.args, field + "." + fixtureId + ".args"),
    });
  }
  return Object.freeze(result);
}

export function validateLiveEvaluationConfig(value: unknown): LiveEvaluationConfig {
  if (!isRecord(value)) {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", "Live evaluation config must be an object.");
  }
  if (value.version !== LIVE_EVALUATION_CONFIG_VERSION) {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", "Unsupported live evaluation config version.");
  }
  if (value.fixtureVersion !== "evaluation-v0") {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", "fixtureVersion must be evaluation-v0.");
  }
  return Object.freeze({
    version: LIVE_EVALUATION_CONFIG_VERSION,
    fixtureVersion: "evaluation-v0",
    trialsPerCase: positiveInteger(value.trialsPerCase, "trialsPerCase"),
    outputDir: text(value.outputDir, "outputDir"),
    model: text(value.model, "model"),
    baseUrl: httpUrl(value.baseUrl, "baseUrl"),
    mcpUrl: httpUrl(value.mcpUrl, "mcpUrl"),
    workspace: text(value.workspace, "workspace"),
    domain: text(value.domain, "domain"),
    domainVersion: text(value.domainVersion, "domainVersion"),
    function: text(value.function, "function"),
    args: jsonObject(value.args, "args"),
    caseTargets: value.caseTargets === undefined ? Object.freeze(Object.create(null)) : caseTargets(value.caseTargets, "caseTargets"),
    timeoutMs: positiveInteger(value.timeoutMs, "timeoutMs"),
  });
}

export function resolveLiveEvaluationConfig(
  input: unknown = {},
  overrides: Partial<Omit<LiveEvaluationConfig, "version" | "fixtureVersion">> = {},
): LiveEvaluationConfig {
  if (!isRecord(input)) {
    throw new LiveEvaluationConfigError("INVALID_CONFIG", "Live evaluation config must be an object.");
  }
  return validateLiveEvaluationConfig({
    ...DEFAULT_LIVE_EVALUATION_CONFIG,
    ...input,
    ...overrides,
    version: LIVE_EVALUATION_CONFIG_VERSION,
    fixtureVersion: "evaluation-v0",
  });
}

function argValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new LiveEvaluationConfigError("INVALID_ARGUMENT", flag + " requires a value.");
  }
  return value;
}

function argInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new LiveEvaluationConfigError("INVALID_ARGUMENT", flag + " must be a positive integer.");
  }
  return Number(value);
}

function argJsonObject(value: string, flag: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LiveEvaluationConfigError("INVALID_ARGUMENT", flag + " must contain valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new LiveEvaluationConfigError("INVALID_ARGUMENT", flag + " must contain a JSON object.");
  }
  return Object.freeze({ ...parsed });
}

export function parseLiveEvaluationArgs(args: readonly string[]): LiveEvaluationCliOptions {
  const result: {
    configPath?: string;
    trialsPerCase?: number;
    outputDir?: string;
    model?: string;
    baseUrl?: string;
    mcpUrl?: string;
    workspace?: string;
    domain?: string;
    domainVersion?: string;
    function?: string;
    args?: Readonly<Record<string, unknown>>;
    timeoutMs?: number;
    help: boolean;
  } = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === "--help" || raw === "-h") {
      result.help = true;
      continue;
    }
    const equals = raw.indexOf("=");
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    const read = (): string => inline ?? argValue(args, index++, flag);
    switch (flag) {
      case "--config": result.configPath = read(); break;
      case "--trials": result.trialsPerCase = argInteger(read(), "--trials"); break;
      case "--output-dir": result.outputDir = read(); break;
      case "--model": result.model = read(); break;
      case "--base-url": result.baseUrl = read(); break;
      case "--mcp-url": result.mcpUrl = read(); break;
      case "--workspace": result.workspace = read(); break;
      case "--domain": result.domain = read(); break;
      case "--domain-version": result.domainVersion = read(); break;
      case "--function": result.function = read(); break;
      case "--args-json": result.args = argJsonObject(read(), "--args-json"); break;
      case "--timeout-ms": result.timeoutMs = argInteger(read(), "--timeout-ms"); break;
      default:
        throw new LiveEvaluationConfigError("INVALID_ARGUMENT", "Unknown argument: " + raw + ".");
    }
  }
  return Object.freeze(result);
}

export function applyLiveEvaluationCliOptions(
  config: LiveEvaluationConfig,
  options: LiveEvaluationCliOptions,
): LiveEvaluationConfig {
  return resolveLiveEvaluationConfig(config, {
    trialsPerCase: options.trialsPerCase ?? config.trialsPerCase,
    outputDir: options.outputDir ?? config.outputDir,
    model: options.model ?? config.model,
    baseUrl: options.baseUrl ?? config.baseUrl,
    mcpUrl: options.mcpUrl ?? config.mcpUrl,
    workspace: options.workspace ?? config.workspace,
    domain: options.domain ?? config.domain,
    domainVersion: options.domainVersion ?? config.domainVersion,
    function: options.function ?? config.function,
    args: options.args ?? config.args,
    timeoutMs: options.timeoutMs ?? config.timeoutMs,
  });
}

function targetForFixture(config: LiveEvaluationConfig, fixture: EvaluationFixture): LiveCaseTarget {
  return Object.hasOwn(config.caseTargets, fixture.id) ? config.caseTargets[fixture.id]
    : { domain: config.domain, version: config.domainVersion, function: config.function, args: config.args };
}

export interface LiveCredentials {
  readonly apiKey: string;
  readonly mcpToken: string;
}

export function resolveLiveCredentials(
  env: Readonly<Record<string, string | undefined>>,
): LiveCredentials {
  const apiKey = env.LIVE_EVAL_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const mcpToken = env.LIVE_EVAL_MCP_TOKEN?.trim() || env.INVARIANT_MCP_TOKEN?.trim();
  if (!apiKey || !mcpToken) {
    throw new LiveEvaluationConfigError(
      "MISSING_CREDENTIALS",
      "Live evaluation requires credentials for both the provider and MCP. Set LIVE_EVAL_API_KEY or OPENAI_API_KEY plus LIVE_EVAL_MCP_TOKEN or INVARIANT_MCP_TOKEN; no provider or MCP call was attempted.",
    );
  }
  return Object.freeze({ apiKey, mcpToken });
}

const SENSITIVE_KEY = /^(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|password|cookie|set-cookie)$/i;
const SECRET_TEXT = /Bearer\s+[A-Za-z0-9._~+/-]+|(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/gi;

function redactText(value: string): string {
  return value.replace(SECRET_TEXT, (match) =>
    match.toLowerCase().startsWith("bearer") ? "Bearer [REDACTED]" : "[REDACTED]");
}

export function redactForRecording(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactForRecording);
  if (isRecord(value)) {
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactForRecording(nested);
    }
    return output;
  }
  return value;
}

export interface LiveCallRequest {
  readonly adapter: AdapterKind;
  readonly prompt: string;
  readonly invariantContext?: {
    readonly knownFacts: readonly string[];
    readonly knownConstraints: readonly string[];
  } | {
    readonly tool: 'domain.evaluate';
    readonly request: DomainEvaluateRequest;
    readonly response: unknown;
  };
}

export interface LiveCallCapture {
  readonly request: LiveCallRequest;
  readonly rawOutput: unknown;
  readonly toolCalls: readonly unknown[];
  readonly invariantToolRequest?: DomainEvaluateRequest;
  readonly invariantToolResponse?: unknown;
}

export interface CapturingEvaluationModel extends EvaluationModel {
  takeLastCall?(): LiveCallCapture | null;
}

export type LiveTrialStatus = "completed" | "missing" | "timeout" | "error";

export interface LiveTrialError {
  readonly name: string;
  readonly message: string;
}

export interface LiveTrialArtifact {
  readonly version: typeof LIVE_TRIAL_RECORD_VERSION;
  readonly trialId: string;
  readonly fixtureId: string;
  readonly family: EvaluationFixture["family"];
  readonly fixtureVersion: EvaluationFixture["version"];
  readonly adapter: AdapterKind;
  readonly trialNumber: number;
  readonly status: LiveTrialStatus;
  readonly response: unknown | null;
  readonly rawOutput: unknown | null;
  readonly toolCalls: readonly unknown[];
  readonly invariantToolRequest: DomainEvaluateRequest | null;
  readonly invariantToolResponse: unknown | null;
  readonly request: LiveCallRequest | null;
  readonly score: ScoreResult | null;
  readonly error: LiveTrialError | null;
}

function makeTrialId(adapter: AdapterKind, fixture: EvaluationFixture, number: number): string {
  return LIVE_TRIAL_RECORD_VERSION + ":" + adapter + ":" + fixture.id + ":trial-" + number;
}

function takeCapture(model: EvaluationModel): LiveCallCapture | null {
  const candidate = model as CapturingEvaluationModel;
  return typeof candidate.takeLastCall === "function" ? candidate.takeLastCall() : null;
}

function takeToolCapture(client: InvariantToolClient | undefined): InvariantToolCapture | null {
  return client !== undefined && typeof client.takeLastCall === "function" ? client.takeLastCall() : null;
}

function mergeCaptures(
  adapter: AdapterKind,
  fixture: EvaluationFixture,
  modelCapture: LiveCallCapture | null,
  toolCapture: InvariantToolCapture | null,
): LiveCallCapture | null {
  if (modelCapture === null && toolCapture === null) return null;
  return {
    request: modelCapture?.request ?? { adapter, prompt: fixture.prompt },
    rawOutput: modelCapture?.rawOutput ?? null,
    toolCalls: modelCapture?.toolCalls ?? [],
    ...(toolCapture === null ? {} : {
      invariantToolRequest: toolCapture.request,
      invariantToolResponse: toolCapture.response,
    }),
  };
}

function safeError(error: unknown): LiveTrialError {
  if (error instanceof Error) return { name: redactText(error.name), message: redactText(error.message) };
  return { name: "UnknownError", message: redactText(String(error)) };
}

export function recordLiveTrial(
  adapter: AdapterKind,
  fixture: EvaluationFixture,
  trialNumber: number,
  record: TrialRecord,
  capture: LiveCallCapture | null = null,
): LiveTrialArtifact {
  if (record.fixtureId !== fixture.id || record.adapter !== adapter) {
    throw new Error("Trial does not match the requested fixture and adapter.");
  }
  return Object.freeze({
    version: LIVE_TRIAL_RECORD_VERSION,
    trialId: makeTrialId(adapter, fixture, trialNumber),
    fixtureId: fixture.id,
    family: fixture.family,
    fixtureVersion: fixture.version,
    adapter,
    trialNumber,
    status: record.episode.status,
    response: redactForRecording(record.response),
    rawOutput: capture === null ? null : redactForRecording(capture.rawOutput),
    toolCalls: capture === null ? [] : redactForRecording(capture.toolCalls) as readonly unknown[],
    invariantToolRequest: capture?.invariantToolRequest === undefined ? null : redactForRecording(capture.invariantToolRequest) as DomainEvaluateRequest,
    invariantToolResponse: capture?.invariantToolResponse === undefined ? null : redactForRecording(capture.invariantToolResponse),
    request: capture === null ? null : redactForRecording(capture.request) as LiveCallRequest,
    score: record.score,
    error: null,
  });
}

export function recordLiveError(
  adapter: AdapterKind,
  fixture: EvaluationFixture,
  trialNumber: number,
  error: unknown,
  capture: LiveCallCapture | null = null,
): LiveTrialArtifact {
  return Object.freeze({
    version: LIVE_TRIAL_RECORD_VERSION,
    trialId: makeTrialId(adapter, fixture, trialNumber),
    fixtureId: fixture.id,
    family: fixture.family,
    fixtureVersion: fixture.version,
    adapter,
    trialNumber,
    status: "error",
    response: null,
    rawOutput: capture === null ? null : redactForRecording(capture.rawOutput),
    toolCalls: capture === null ? [] : redactForRecording(capture.toolCalls) as readonly unknown[],
    invariantToolRequest: capture?.invariantToolRequest === undefined ? null : redactForRecording(capture.invariantToolRequest) as DomainEvaluateRequest,
    invariantToolResponse: capture?.invariantToolResponse === undefined ? null : redactForRecording(capture.invariantToolResponse),
    request: capture === null ? null : redactForRecording(capture.request) as LiveCallRequest,
    score: null,
    error: safeError(error),
  });
}

export async function runLiveEvaluation(
  config: LiveEvaluationConfig,
  fixtures: readonly EvaluationFixture[] = OFFLINE_EVALUATION_FIXTURES,
  createModel: (adapter: AdapterKind, invariantToolClient?: InvariantToolClient) => EvaluationModel | Promise<EvaluationModel>,
  createInvariantToolClient: () => InvariantToolClient | Promise<InvariantToolClient>,
): Promise<readonly LiveTrialArtifact[]> {
  config = validateLiveEvaluationConfig(config);
  if (!Array.isArray(fixtures)) throw new Error('Expected an array of evaluation fixtures.');
  fixtures = Object.freeze(fixtures.map(snapshotEvaluationFixture));
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) throw new Error('Duplicate benchmark fixture IDs.');
  const artifacts: LiveTrialArtifact[] = [];
  for (const adapter of [llmOnlyAdapter, llmInvariantAdapter]) {
    let model: EvaluationModel | undefined;
    let factoryError: unknown;
    let invariantToolClient: InvariantToolClient | undefined;
    try {
      if (adapter.kind === "llm-invariant") {
        invariantToolClient = await createInvariantToolClient();
      }
      model = await createModel(adapter.kind, invariantToolClient);
    } catch (error) {
      factoryError = error;
    }
    for (let trialNumber = 1; trialNumber <= config.trialsPerCase; trialNumber += 1) {
      for (const fixture of fixtures) {
        if (model === undefined) {
          artifacts.push(recordLiveError(adapter.kind, fixture, trialNumber, factoryError ?? new Error("Model was not created.")));
          continue;
        }
        try {
          const record = await adapter.run(fixture, model, adapter.kind === "llm-invariant"
            ? {
              invariantToolClient: invariantToolClient as InvariantToolClient,
              invariantToolRequest: (candidate) => {
                const target = targetForFixture(config, candidate);
                return { workspace: config.workspace, domain: target.domain, version: target.version, function: target.function, args: target.args };
              },
            }
            : undefined);
          artifacts.push(recordLiveTrial(
            adapter.kind,
            fixture,
            trialNumber,
            record,
            mergeCaptures(adapter.kind, fixture, takeCapture(model), takeToolCapture(invariantToolClient)),
          ));
        } catch (error) {
          artifacts.push(recordLiveError(
            adapter.kind,
            fixture,
            trialNumber,
            error,
            mergeCaptures(adapter.kind, fixture, takeCapture(model), takeToolCapture(invariantToolClient)),
          ));
        }
      }
    }
  }
  return Object.freeze(artifacts);
}

export function rescoreLiveTrial(
  artifact: LiveTrialArtifact,
  fixture: EvaluationFixture,
): LiveTrialArtifact {
  if (artifact.fixtureId !== fixture.id || artifact.fixtureVersion !== fixture.version) {
    throw new Error("Trial does not match the requested fixture.");
  }
  if (artifact.error !== null || artifact.response === null || artifact.score === null) return artifact;
  const status = artifact.status === "error" ? "completed" : artifact.status;
  const rescored = rescoreTrial({
    version: "trial-v0",
    trialId: artifact.trialId,
    fixtureId: artifact.fixtureId,
    fixtureVersion: artifact.fixtureVersion,
    adapter: artifact.adapter,
    episode: { status },
    response: artifact.response,
    score: artifact.score,
  }, fixture);
  return Object.freeze({ ...artifact, status: rescored.episode.status, score: rescored.score });
}

export function serializeLiveTrial(artifact: LiveTrialArtifact): string {
  return JSON.stringify(artifact);
}

export function deserializeLiveTrial(serialized: string): LiveTrialArtifact {
  const value: unknown = parseJsonValue(JSON.parse(serialized), '$');
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const episode = (value: unknown) => ['completed', 'missing', 'timeout'].includes(String(value));
  const score = isRecord(value) ? value.score : undefined;
  const error = isRecord(value) ? value.error : undefined;
  if (!isRecord(value) ||
      value.version !== LIVE_TRIAL_RECORD_VERSION ||
      !text(value.trialId) || !text(value.fixtureId) ||
      value.fixtureVersion !== EVALUATION_FIXTURE_VERSION ||
      !EVALUATION_CASE_FAMILIES.some((family) => family === value.family) ||
      (value.adapter !== "llm-only" && value.adapter !== "llm-invariant") ||
      typeof value.trialNumber !== "number" || !Number.isSafeInteger(value.trialNumber) || value.trialNumber < 1 ||
      (!episode(value.status) && value.status !== 'error') ||
      value.trialId !== `${LIVE_TRIAL_RECORD_VERSION}:${value.adapter}:${value.fixtureId}:trial-${value.trialNumber}` ||
      !['response', 'rawOutput', 'invariantToolResponse'].every((key) => Object.hasOwn(value, key)) ||
      !Array.isArray(value.toolCalls) ||
      (value.request !== null && (!isRecord(value.request) || value.request.adapter !== value.adapter || typeof value.request.prompt !== 'string')) ||
      (value.invariantToolRequest !== null && (!isRecord(value.invariantToolRequest)
        || !['workspace', 'domain', 'version', 'function'].every((key) => text((value.invariantToolRequest as Record<string, unknown>)[key]))
        || !isRecord(value.invariantToolRequest.args))) ||
      (score !== null && !isScoreResult(score)) ||
      (error !== null && (!isRecord(error) || typeof error.name !== 'string' || typeof error.message !== 'string')) ||
      (value.status === 'error' ? error === null || score !== null || value.response !== null
        : error !== null || score === null || (isRecord(score) && score.episodeStatus !== value.status))) {
    throw new Error("Invalid live trial artifact.");
  }
  return value as unknown as LiveTrialArtifact;
}

const SCORE_LABELS: readonly ScoreLabel[] = ["correct", "wrong", "unknown", "invented", "invalid"];

export interface LiveConditionSummary {
  readonly adapter: AdapterKind;
  readonly total: number;
  readonly completed: number;
  readonly missing: number;
  readonly timeout: number;
  readonly errors: number;
  readonly scored: number;
  readonly passed: number;
  readonly failed: number;
  readonly points: number;
  readonly passRate: number | null;
  readonly overallPassRate: number | null;
  readonly scoringCoverage: number | null;
  readonly labels: Readonly<Record<ScoreLabel, number>>;
}

export interface LiveCaseConditionSummary {
  readonly total: number;
  readonly scored: number;
  readonly passed: number;
  readonly errors: number;
  readonly points: number;
  readonly passRate: number | null;
  readonly labels: Readonly<Record<ScoreLabel, number>>;
}

export interface LiveCaseReport {
  readonly fixtureId: string;
  readonly family: EvaluationFixture["family"];
  readonly conditions: Readonly<Record<AdapterKind, LiveCaseConditionSummary>>;
}

export interface LiveReportError {
  readonly trialId: string;
  readonly adapter: AdapterKind;
  readonly fixtureId: string;
  readonly trialNumber: number;
  readonly name: string;
  readonly message: string;
}

export interface LiveRegression {
  readonly fixtureId: string;
  readonly family: EvaluationFixture["family"];
  readonly trialNumber: number;
  readonly baseline: { readonly label: ScoreLabel; readonly points: number };
  readonly invariant: { readonly label: ScoreLabel; readonly points: number };
  readonly reason: "invariant-scored-lower";
}

export interface LiveImprovement {
  readonly fixtureId: string;
  readonly family: EvaluationFixture["family"];
  readonly trialNumber: number;
  readonly baseline: { readonly label: ScoreLabel; readonly points: number };
  readonly invariant: { readonly label: ScoreLabel; readonly points: number };
}

export interface LiveComparison {
  readonly status: "scored" | "insufficient-data";
  readonly pairedTrials: number;
  readonly scoredPairs: number;
  readonly unscoredPairs: number;
  readonly llmOnlyPoints: number;
  readonly llmInvariantPoints: number;
  readonly deltaPoints: number;
  readonly regressions: readonly LiveRegression[];
  readonly improvements: readonly LiveImprovement[];
  readonly claim: "insufficient-data" | "invariant-higher-on-recorded-pairs" | "no-point-delta-on-recorded-pairs" | "invariant-lower-on-recorded-pairs";
}

export interface LiveReport {
  readonly version: typeof LIVE_REPORT_VERSION;
  readonly fixtureVersion: "evaluation-v0";
  readonly generatedAt?: string;
  readonly conditions: Readonly<Record<AdapterKind, LiveConditionSummary>>;
  readonly cases: readonly LiveCaseReport[];
  readonly errors: readonly LiveReportError[];
  readonly regressions: readonly LiveRegression[];
  readonly comparison: LiveComparison;
}

function emptyLabels(): Record<ScoreLabel, number> {
  return { correct: 0, wrong: 0, unknown: 0, invented: 0, invalid: 0 };
}

function summarize(adapter: AdapterKind, artifacts: readonly LiveTrialArtifact[]): LiveConditionSummary {
  const labels = emptyLabels();
  let completed = 0;
  let missing = 0;
  let timeout = 0;
  let errors = 0;
  let scored = 0;
  let passed = 0;
  let points = 0;
  for (const artifact of artifacts) {
    if (artifact.status === "completed") completed += 1;
    if (artifact.status === "missing") missing += 1;
    if (artifact.status === "timeout") timeout += 1;
    if (artifact.status === "error") errors += 1;
    if (artifact.score !== null) {
      scored += 1;
      labels[artifact.score.label] += 1;
      points += artifact.score.points;
      if (artifact.score.passed) passed += 1;
    }
  }
  return Object.freeze({
    adapter,
    total: artifacts.length,
    completed,
    missing,
    timeout,
    errors,
    scored,
    passed,
    failed: scored - passed,
    points,
    passRate: scored === 0 ? null : passed / scored,
    overallPassRate: artifacts.length === 0 ? null : passed / artifacts.length,
    scoringCoverage: artifacts.length === 0 ? null : scored / artifacts.length,
    labels: Object.freeze(labels),
  });
}

function caseSummary(artifacts: readonly LiveTrialArtifact[]): LiveCaseConditionSummary {
  const value = summarize(artifacts[0]?.adapter ?? "llm-only", artifacts);
  return Object.freeze({
    total: value.total,
    scored: value.scored,
    passed: value.passed,
    errors: value.errors,
    points: value.points,
    passRate: value.passRate,
    labels: value.labels,
  });
}

function pairKey(artifact: LiveTrialArtifact): string {
  return artifact.fixtureId + ":" + artifact.trialNumber;
}

export function aggregateLiveReport(
  artifacts: readonly LiveTrialArtifact[],
  fixtures: readonly EvaluationFixture[] = OFFLINE_EVALUATION_FIXTURES,
  generatedAt?: string,
): LiveReport {
  const fixtureMap = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  if (fixtureMap.size !== fixtures.length) throw new Error('Duplicate benchmark fixture IDs.');
  const seen = new Set<string>();
  const checked = artifacts.map((input) => {
    const artifact = deserializeLiveTrial(serializeLiveTrial(input));
    const fixture = fixtureMap.get(artifact.fixtureId);
    if (!fixture || fixture.version !== artifact.fixtureVersion || fixture.family !== artifact.family) throw new Error('Trial is outside the declared benchmark.');
    if (seen.has(artifact.trialId)) throw new Error('Duplicate live trial.');
    seen.add(artifact.trialId);
    if (artifact.status === 'error') return artifact;
    // Persisted score claims are untrusted; the supplied benchmark remains the oracle.
    const score = scoreResponse(fixture, artifact.response);
    return Object.freeze({ ...artifact, score, status: score.episodeStatus });
  });
  const sorted = checked.sort((left, right) => compareCanonicalText(left.trialId, right.trialId));
  const errors = sorted.filter((item) => item.error !== null).map((item) => ({
    trialId: item.trialId,
    adapter: item.adapter,
    fixtureId: item.fixtureId,
    trialNumber: item.trialNumber,
    name: item.error?.name ?? "UnknownError",
    message: item.error?.message ?? "Unknown live evaluation error.",
  }));
  const conditions = {
    "llm-only": summarize("llm-only", sorted.filter((item) => item.adapter === "llm-only")),
    "llm-invariant": summarize("llm-invariant", sorted.filter((item) => item.adapter === "llm-invariant")),
  } as const;
  const cases = fixtures.map((fixture) => ({
    fixtureId: fixture.id,
    family: fixture.family,
    conditions: {
      "llm-only": caseSummary(sorted.filter((item) => item.adapter === "llm-only" && item.fixtureId === fixture.id)),
      "llm-invariant": caseSummary(sorted.filter((item) => item.adapter === "llm-invariant" && item.fixtureId === fixture.id)),
    },
  }));
  const baseline = new Map(sorted.filter((item) => item.adapter === "llm-only").map((item) => [pairKey(item), item]));
  const regressions: LiveRegression[] = [];
  const improvements: LiveImprovement[] = [];
  let pairedTrials = 0;
  let scoredPairs = 0;
  let unscoredPairs = 0;
  let llmOnlyPoints = 0;
  let llmInvariantPoints = 0;
  for (const invariant of sorted.filter((item) => item.adapter === "llm-invariant")) {
    const only = baseline.get(pairKey(invariant));
    if (only === undefined) continue;
    pairedTrials += 1;
    if (only.score === null || invariant.score === null) {
      unscoredPairs += 1;
      continue;
    }
    scoredPairs += 1;
    llmOnlyPoints += only.score.points;
    llmInvariantPoints += invariant.score.points;
    const fixture = fixtures.find((candidate) => candidate.id === invariant.fixtureId);
    if (fixture === undefined) continue;
    const baselineScore = { label: only.score.label, points: only.score.points };
    const invariantScore = { label: invariant.score.label, points: invariant.score.points };
    if (invariant.score.points < only.score.points) {
      regressions.push({ fixtureId: fixture.id, family: fixture.family, trialNumber: invariant.trialNumber, baseline: baselineScore, invariant: invariantScore, reason: "invariant-scored-lower" });
    } else if (invariant.score.points > only.score.points) {
      improvements.push({ fixtureId: fixture.id, family: fixture.family, trialNumber: invariant.trialNumber, baseline: baselineScore, invariant: invariantScore });
    }
  }
  const deltaPoints = llmInvariantPoints - llmOnlyPoints;
  const claim = scoredPairs === 0
    ? "insufficient-data"
    : deltaPoints > 0
      ? "invariant-higher-on-recorded-pairs"
      : deltaPoints < 0
        ? "invariant-lower-on-recorded-pairs"
        : "no-point-delta-on-recorded-pairs";
  const comparison = {
    status: scoredPairs === 0 ? "insufficient-data" : "scored",
    pairedTrials,
    scoredPairs,
    unscoredPairs,
    llmOnlyPoints,
    llmInvariantPoints,
    deltaPoints,
    regressions: Object.freeze(regressions),
    improvements: Object.freeze(improvements),
    claim,
  } as const;
  return Object.freeze({
    version: LIVE_REPORT_VERSION,
    fixtureVersion: "evaluation-v0",
    ...(generatedAt === undefined ? {} : { generatedAt }),
    conditions,
    cases: Object.freeze(cases),
    errors: Object.freeze(errors),
    regressions: Object.freeze(regressions),
    comparison: Object.freeze(comparison),
  });
}

function percentage(value: number | null): string {
  return value === null ? "n/a" : (value * 100).toFixed(1) + "%";
}

function conditionName(adapter: AdapterKind): string {
  return adapter === "llm-only" ? "LLM-only" : "LLM+Invariant";
}

export function renderLiveReportMarkdown(report: LiveReport): string {
  const lines: string[] = [
    "# Live evaluation report",
    "",
    "- Fixture version: " + report.fixtureVersion,
    "- Report version: " + report.version,
    ...(report.generatedAt === undefined ? [] : ["- Generated at: " + report.generatedAt]),
    "",
    "## Aggregate",
    "",
    "| Condition | Trials | Scored | Passed | Errors | Points | Pass/scored | Pass/all trials | Scored/all trials |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const adapter of ["llm-only", "llm-invariant"] as const) {
    const summary = report.conditions[adapter];
    lines.push("| " + conditionName(adapter) + " | " + summary.total + " | " + summary.scored + " | " + summary.passed + " | " + summary.errors + " | " + summary.points + " | " + percentage(summary.passRate) + " | " + percentage(summary.overallPassRate) + " | " + percentage(summary.scoringCoverage) + " |");
  }
  lines.push("", "## Per-case", "", "| Case | LLM-only | LLM+Invariant |", "| --- | --- | --- |");
  for (const entry of report.cases) {
    const only = entry.conditions["llm-only"];
    const invariant = entry.conditions["llm-invariant"];
    lines.push("| " + entry.family + " (" + entry.fixtureId + ") | " + only.passed + "/" + only.scored + " passed, " + only.errors + " errors, " + only.points + " points | " + invariant.passed + "/" + invariant.scored + " passed, " + invariant.errors + " errors, " + invariant.points + " points |");
  }
  lines.push(
    "",
    "## Comparison",
    "",
    "- Status: " + report.comparison.status,
    "- Paired trials: " + report.comparison.pairedTrials + "; scored pairs: " + report.comparison.scoredPairs + "; unscored pairs: " + report.comparison.unscoredPairs,
    "- Point delta (LLM+Invariant minus LLM-only): " + report.comparison.deltaPoints,
    "- Bounded claim: " + report.comparison.claim,
    "",
    "### Regressions",
  );
  if (report.regressions.length === 0) lines.push("", "- None recorded.");
  for (const regression of report.regressions) {
    lines.push("", "- REGRESSION: " + regression.fixtureId + " trial " + regression.trialNumber + ": " + regression.baseline.label + " (" + regression.baseline.points + ") -> " + regression.invariant.label + " (" + regression.invariant.points + ").");
  }
  lines.push("", "## Errors");
  if (report.errors.length === 0) lines.push("", "- None recorded.");
  for (const error of report.errors) {
    lines.push("", "- ERROR: " + error.trialId + " (" + error.name + "): " + error.message);
  }
  lines.push("", "> Only saved provider responses are scored. Errors, regressions, and insufficient data remain visible.");
  return lines.join("\n") + "\n";
}
