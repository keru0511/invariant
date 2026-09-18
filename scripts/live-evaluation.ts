import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  aggregateLiveReport,
  applyLiveEvaluationCliOptions,
  LiveEvaluationConfigError,
  parseLiveEvaluationArgs,
  redactForRecording,
  renderLiveReportMarkdown,
  resolveLiveCredentials,
  resolveLiveEvaluationConfig,
  runLiveEvaluation,
  type CapturingEvaluationModel,
  type LiveCallCapture,
  type LiveEvaluationConfig,
  type LiveEvaluationCliOptions,
} from "../src/domain/live-evaluation";
import { OFFLINE_EVALUATION_FIXTURES } from "../src/domain/evaluation-fixtures";
import type { AdapterKind, EvaluationFixture } from "../src/domain/evaluation";

const USAGE = [
  "Usage: npm run eval:live -- [options]",
  "",
  "  --config PATH       JSON config (default: config/live-evaluation-v0.json)",
  "  --trials N          attempts per case and condition (default: 1)",
  "  --output-dir PATH  artifact directory",
  "  --model NAME        provider model",
  "  --base-url URL      OpenAI-compatible API base URL",
  "  --timeout-ms N      per-call timeout",
  "  --help              show this help",
  "",
  "Credentials: LIVE_EVAL_API_KEY or OPENAI_API_KEY.",
].join("\n") + "\n";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerContent(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) return payload;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return payload;
  const message = first.message;
  if (typeof message.content === "string") {
    let content = message.content.trim();
    const fence = String.fromCharCode(96).repeat(3);
    if (content.startsWith(fence)) {
      const newline = content.indexOf("\n");
      content = newline === -1 ? content.slice(fence.length) : content.slice(newline + 1);
      if (content.endsWith(fence)) content = content.slice(0, -fence.length).trim();
    }
    try {
      return JSON.parse(content);
    } catch {
      return message.content;
    }
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const call = message.tool_calls[0];
    if (isRecord(call) && isRecord(call.function) && typeof call.function.arguments === "string") {
      try {
        return JSON.parse(call.function.arguments);
      } catch {
        return call.function.arguments;
      }
    }
  }
  return payload;
}

function providerToolCalls(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) return [];
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || !Array.isArray(first.message.tool_calls)) return [];
  return first.message.tool_calls;
}

class OpenAICompatibleModel implements CapturingEvaluationModel {
  private capture: LiveCallCapture | null = null;

  constructor(
    private readonly config: LiveEvaluationConfig,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async complete(request: {
    readonly fixture: EvaluationFixture;
    readonly adapter: AdapterKind;
    readonly prompt: string;
    readonly invariantContext?: {
      readonly knownFacts: readonly string[];
      readonly knownConstraints: readonly string[];
    };
  }): Promise<unknown> {
    const context = request.invariantContext === undefined
      ? "No additional invariant context is available."
      : "Invariant context. Known facts: " + request.invariantContext.knownFacts.join(", ") +
        ". Known constraints: " + request.invariantContext.knownConstraints.join(", ") + ".";
    const body = {
      model: this.config.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Return only JSON with status, answer, facts, and constraints. " +
            "status must be completed, missing, or timeout; answer is a string or null; " +
            "facts and constraints are arrays of exact identifiers. " + context,
        },
        { role: "user", content: request.prompt },
      ],
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      this.capture = {
        request: {
          adapter: request.adapter,
          prompt: request.prompt,
          ...(request.invariantContext === undefined ? {} : { invariantContext: request.invariantContext }),
        },
        rawOutput: payload,
        toolCalls: providerToolCalls(payload),
      };
      if (!response.ok) {
        const detail = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
          ? payload.error.message
          : "provider returned a non-success response";
        throw new Error("Provider HTTP " + response.status + ": " + String(redactForRecording(detail)));
      }
      return providerContent(payload);
    } catch (error) {
      if (this.capture === null) {
        this.capture = {
          request: { adapter: request.adapter, prompt: request.prompt },
          rawOutput: { error: error instanceof Error ? error.message : String(error) },
          toolCalls: [],
        };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  takeLastCall(): LiveCallCapture | null {
    const value = this.capture;
    this.capture = null;
    return value;
  }
}

interface CommandIO {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIO: CommandIO = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

async function loadConfig(path: string): Promise<LiveEvaluationConfig> {
  const source = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Config is not valid JSON: " + path);
  }
  return resolveLiveEvaluationConfig(parsed);
}

function environmentOverrides(
  config: LiveEvaluationConfig,
  env: Readonly<Record<string, string | undefined>>,
): LiveEvaluationConfig {
  return resolveLiveEvaluationConfig(config, {
    model: env.LIVE_EVAL_MODEL?.trim() || env.OPENAI_MODEL?.trim() || config.model,
    baseUrl: env.LIVE_EVAL_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || config.baseUrl,
  });
}

function artifactName(trialId: string): string {
  return trialId.replace(/[^A-Za-z0-9._-]+/g, "_") + ".json";
}

async function saveArtifacts(
  config: LiveEvaluationConfig,
  artifacts: readonly import("../src/domain/live-evaluation").LiveTrialArtifact[],
  report: import("../src/domain/live-evaluation").LiveReport,
): Promise<string> {
  const outputDir = resolve(process.cwd(), config.outputDir);
  const trialDir = join(outputDir, "trials");
  await mkdir(trialDir, { recursive: true });
  await writeFile(join(outputDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  for (const artifact of artifacts) {
    await writeFile(join(trialDir, artifactName(artifact.trialId)), JSON.stringify(artifact, null, 2) + "\n", "utf8");
  }
  await writeFile(join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(join(outputDir, "report.md"), renderLiveReportMarkdown(report), "utf8");
  return outputDir;
}

export async function runLiveEvaluationCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CommandIO = defaultIO,
): Promise<number> {
  try {
    const options: LiveEvaluationCliOptions = parseLiveEvaluationArgs(argv);
    if (options.help) {
      io.stdout(USAGE);
      return 0;
    }
    const configPath = resolve(process.cwd(), options.configPath ?? "config/live-evaluation-v0.json");
    let config = applyLiveEvaluationCliOptions(await loadConfig(configPath), options);
    config = environmentOverrides(config, env);
    const credentials = resolveLiveCredentials(env);
    const artifacts = await runLiveEvaluation(
      config,
      OFFLINE_EVALUATION_FIXTURES,
      () => new OpenAICompatibleModel(config, credentials.apiKey),
    );
    const report = aggregateLiveReport(artifacts, OFFLINE_EVALUATION_FIXTURES, new Date().toISOString());
    const outputDir = await saveArtifacts(config, artifacts, report);
    io.stdout("Saved live evaluation artifacts to " + outputDir + "\n");
    if (report.errors.length > 0) {
      io.stderr("Live evaluation completed with " + report.errors.length + " recorded provider errors; see report.json.\n");
      return 1;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr("Live evaluation failed: " + message + "\n");
    return error instanceof LiveEvaluationConfigError ? 2 : 1;
  }
}

if (process.env.VITEST !== "true" && process.argv.some((item) => item.endsWith("scripts/live-evaluation.ts"))) {
  runLiveEvaluationCommand(process.argv.slice(2), process.env).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
