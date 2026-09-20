import { describe, expect, it } from "vitest";
import {
  aggregateLiveReport,
  DEFAULT_LIVE_EVALUATION_CONFIG,
  deserializeLiveTrial,
  parseLiveEvaluationArgs,
  redactForRecording,
  recordLiveError,
  recordLiveTrial,
  renderLiveReportMarkdown,
  resolveLiveCredentials,
  resolveLiveEvaluationConfig,
  rescoreLiveTrial,
  runLiveEvaluation,
  serializeLiveTrial,
  type CapturingEvaluationModel,
  type LiveCallCapture,
} from "./live-evaluation";
import {
  fixtureById,
  OFFLINE_EVALUATION_FIXTURES,
} from "./evaluation-fixtures";
import {
  llmInvariantAdapter,
  llmOnlyAdapter,
  type EvaluationFixture,
  type InvariantToolCapture,
  type InvariantToolClient,
  type DomainEvaluateRequest,
  type ModelRequest,
} from "./evaluation";

function responseFor(fixture: EvaluationFixture, answer: string | null = fixture.expected.answer): Record<string, unknown> {
  return {
    status: "completed",
    answer,
    facts: [...fixture.expected.requiredFacts],
    constraints: [...fixture.expected.requiredConstraints],
  };
}

class FakeModel implements CapturingEvaluationModel {
  private capture: LiveCallCapture | null = null;

  constructor(
    private readonly response: unknown,
    private readonly failure?: Error,
  ) {}

  async complete(request: ModelRequest): Promise<unknown> {
    this.capture = {
      request: {
        adapter: request.adapter,
        prompt: request.prompt,
        ...(request.invariantContext === undefined ? {} : { invariantContext: request.invariantContext }),
      },
      rawOutput: {
        authorization: "Bearer live-secret",
        api_key: "sk-test-secret",
        choices: [{ message: { content: JSON.stringify(this.response), tool_calls: [{ function: { arguments: "safe" } }] } }],
      },
      toolCalls: [{ authorization: "Bearer tool-secret" }],
    };
    if (this.failure !== undefined) throw this.failure;
    return this.response;
  }

  takeLastCall(): LiveCallCapture | null {
    const capture = this.capture;
    this.capture = null;
    return capture;
  }
}

class RecordedInvariantToolClient implements InvariantToolClient {
  readonly requests: DomainEvaluateRequest[] = [];
  private capture: InvariantToolCapture | null = null;

  async evaluate(request: DomainEvaluateRequest): Promise<unknown> {
    this.requests.push(request);
    const response = {
      status: "resolved",
      decision: "allow",
      value: true,
      workspace: request.workspace,
      domain: request.domain,
      version: request.version,
      function: request.function,
      trace: [{ nodeId: "node.tool" }],
      provenance: { functionId: "function.tool", ruleIds: ["rule.tool"] },
    };
    this.capture = { request, response };
    return response;
  }

  takeLastCall(): InvariantToolCapture | null {
    const value = this.capture;
    this.capture = null;
    return value;
  }
}

describe("live evaluation configuration and recording", () => {
  it("validates the smoke default and command overrides without I/O", () => {
    expect(DEFAULT_LIVE_EVALUATION_CONFIG.trialsPerCase).toBe(1);
    expect(DEFAULT_LIVE_EVALUATION_CONFIG).toMatchObject({
      workspace: "workspace-a",
      domain: "orders",
      domainVersion: "v1",
      function: "member-age",
      args: { user: { age: 21 } },
      caseTargets: expect.any(Object),
    });
    expect(parseLiveEvaluationArgs(["--trials", "3", "--timeout-ms=5000"])).toMatchObject({
      trialsPerCase: 3,
      timeoutMs: 5000,
      help: false,
    });
    expect(parseLiveEvaluationArgs(["--args-json", "{\"user\":{\"age\":18}}"])).toMatchObject({
      args: { user: { age: 18 } },
    });
    expect(() => parseLiveEvaluationArgs(["--trials", "0"])).toThrow(/positive integer/);
    expect(() => parseLiveEvaluationArgs(["--unknown"])).toThrow(/Unknown argument/);
    expect(() => resolveLiveEvaluationConfig({ ...DEFAULT_LIVE_EVALUATION_CONFIG, baseUrl: "file:///tmp/provider" })).toThrow(/http/);
  });

  it("fails credential validation before any provider call", () => {
    expect(() => resolveLiveCredentials({})).toThrow(/no provider or MCP call was attempted/);
    expect(resolveLiveCredentials({ LIVE_EVAL_API_KEY: "key", LIVE_EVAL_MCP_TOKEN: "mcp" })).toMatchObject({
      apiKey: "key",
      mcpToken: "mcp",
    });
  });

  it("redacts credentials recursively, including raw output and tool calls", () => {
    expect(redactForRecording({
      authorization: "Bearer live-secret",
      nested: { api_key: "sk-test-secret", text: "Bearer another-secret" },
    })).toEqual({
      authorization: "[REDACTED]",
      nested: { api_key: "[REDACTED]", text: "Bearer [REDACTED]" },
    });
  });

  it("runs both injected adapters, records redacted evidence, and rescoring is offline", async () => {
    const fixture = fixtureById("evaluation-v0.threshold");
    const config = resolveLiveEvaluationConfig(DEFAULT_LIVE_EVALUATION_CONFIG, { trialsPerCase: 1 });
    const toolClient = new RecordedInvariantToolClient();
    const artifacts = await runLiveEvaluation(
      config,
      [fixture],
      () => new FakeModel(responseFor(fixture)),
      () => toolClient,
    );
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((item) => item.adapter)).toEqual(["llm-only", "llm-invariant"]);
    expect(toolClient.requests).toHaveLength(1);
    expect(toolClient.requests[0]).toMatchObject({
      workspace: "workspace-a",
      domain: "orders",
      version: "v1",
      function: "refund",
      args: { order: { status: "paid", total: 150 } },
    });
    expect(JSON.stringify(toolClient.requests[0])).not.toContain(fixture.id);
    expect(JSON.stringify(toolClient.requests[0])).not.toContain(fixture.prompt);
    expect(artifacts[1].request?.invariantContext).toMatchObject({
      tool: "domain.evaluate",
      request: toolClient.requests[0],
      response: { status: "resolved", workspace: "workspace-a" },
    });
    expect(artifacts[1].invariantToolRequest).toMatchObject(toolClient.requests[0]);
    expect(artifacts[1].invariantToolResponse).toMatchObject({ status: "resolved" });
    expect(JSON.stringify(artifacts[1].invariantToolRequest)).not.toContain("knownFacts");
    expect(artifacts[0].rawOutput).toMatchObject({ authorization: "[REDACTED]", api_key: "[REDACTED]" });
    expect(artifacts[0].toolCalls[0]).toEqual({ authorization: "[REDACTED]" });
    const reloaded = deserializeLiveTrial(serializeLiveTrial(artifacts[0]));
    const rescored = rescoreLiveTrial(reloaded, fixture);
    expect(rescored.score).toMatchObject({ label: "correct", passed: true });
  });

  it("uses a distinct configured real-domain request for every evaluation case", async () => {
    const config = resolveLiveEvaluationConfig(DEFAULT_LIVE_EVALUATION_CONFIG, { trialsPerCase: 1 });
    const toolClient = new RecordedInvariantToolClient();
    await runLiveEvaluation(
      config,
      OFFLINE_EVALUATION_FIXTURES,
      () => new FakeModel(responseFor(OFFLINE_EVALUATION_FIXTURES[0])),
      () => toolClient,
    );
    expect(toolClient.requests).toEqual([
      { workspace: "workspace-a", domain: "orders", version: "v1", function: "member-age", args: { user: { age: 17 } } },
      { workspace: "workspace-a", domain: "orders", version: "v1", function: "member-age", args: { user: { age: 21 } } },
      { workspace: "workspace-a", domain: "orders", version: "v1", function: "refund", args: { order: { status: "paid", total: 150 } } },
      { workspace: "workspace-a", domain: "orders", version: "v1", function: "account-review", args: { account: { state: "active", riskScore: 10, country: "JP" } } },
      { workspace: "workspace-a", domain: "orders", version: "v1", function: "refund", args: { order: { status: "paid", total: 50 } } },
    ]);
    expect(new Set(toolClient.requests.map((request) => JSON.stringify(request))).size).toBe(5);
  });

  it("preserves provider errors and exposes regressions in aggregate and markdown", async () => {
    const first = fixtureById("evaluation-v0.threshold");
    const second = fixtureById("evaluation-v0.exception");
    const onlyRecord = await llmOnlyAdapter.run(first, { complete: async () => responseFor(first) });
    const invariantRecord = await llmInvariantAdapter.run(first, { complete: async () => responseFor(first, "allow") }, {
      invariantToolClient: new RecordedInvariantToolClient(),
      invariantToolRequest: () => ({
        workspace: "workspace-a",
        domain: "orders",
        version: "v1",
        function: "member-age",
        args: { user: { age: 21 } },
      }),
    });
    const artifacts = [
      recordLiveTrial("llm-only", first, 1, onlyRecord),
      recordLiveTrial("llm-invariant", first, 1, invariantRecord),
      recordLiveError("llm-invariant", second, 1, new Error("provider unavailable")),
    ];
    const report = aggregateLiveReport(artifacts, [first, second], "2026-09-18T00:00:00.000Z");
    expect(report.errors).toHaveLength(1);
    expect(report.regressions).toHaveLength(1);
    expect(report.comparison).toMatchObject({
      status: "scored",
      pairedTrials: 1,
      scoredPairs: 1,
      deltaPoints: -1,
    });
    const markdown = renderLiveReportMarkdown(report);
    expect(markdown).toContain("REGRESSION");
    expect(markdown).toContain("ERROR");
    expect(markdown).toContain("provider unavailable");
  });

  it("keeps insufficient data explicit when every paired condition errors", () => {
    const fixture = OFFLINE_EVALUATION_FIXTURES[0];
    const report = aggregateLiveReport([
      recordLiveError("llm-only", fixture, 1, new Error("only failed")),
      recordLiveError("llm-invariant", fixture, 1, new Error("invariant failed")),
    ], [fixture]);
    expect(report.comparison.status).toBe("insufficient-data");
    expect(report.comparison.claim).toBe("insufficient-data");
    expect(report.errors).toHaveLength(2);
  });
});
