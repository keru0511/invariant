import { describe, expect, it } from "vitest";
import { handleMcpRequest } from '../src/worker/mcp';
import { parseDomainOrThrow } from '../src/domain/runtime';
import catalog from '../fixtures/domain-v0/functions.json';
import { DEFAULT_LIVE_EVALUATION_CONFIG, resolveLiveEvaluationConfig } from "../src/domain/live-evaluation";
import {
  CF_ACCESS_JWT_ASSERTION_HEADER,
  HttpInvariantToolClient,
  OpenAICompatibleModel,
  runLiveEvaluationCommand,
} from "./live-evaluation";

describe("live evaluation command", () => {
  it("returns a clear non-zero result without credentials and does not call a provider", async () => {
    let stderr = "";
    let stdout = "";
    const exitCode = await runLiveEvaluationCommand([], {}, {
      stderr: (message) => { stderr += message; },
      stdout: (message) => { stdout += message; },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("requires credentials");
    expect(stderr).toContain("no provider or MCP call was attempted");
    expect(stdout).toBe("");
  });

  it("provides a runnable help command without credentials", async () => {
    let stdout = "";
    const exitCode = await runLiveEvaluationCommand(["--help"], {}, {
      stderr: () => undefined,
      stdout: (message) => { stdout += message; },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("npm run eval:live");
    expect(stdout).toContain("LIVE_EVAL_API_KEY");
    expect(stdout).toContain("LIVE_EVAL_MCP_TOKEN");
  });

  it("sends an authenticated domain.evaluate MCP request and records its tool response", async () => {
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const config = resolveLiveEvaluationConfig(DEFAULT_LIVE_EVALUATION_CONFIG, {
      mcpUrl: "https://invariant.example/mcp",
    });
    const client = new HttpInvariantToolClient(config, "mcp-secret", async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "resolved",
              decision: "allow",
              value: true,
              workspace: "workspace-a",
              domain: "orders",
              version: "v1",
              function: "member-age",
              trace: [{ nodeId: "node-a" }],
              provenance: { functionId: "function.member-age" },
            }),
          }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const request = {
      workspace: "workspace-a",
      domain: "orders",
      version: "v1",
      function: "member-age",
      args: { user: { age: 21 } },
    } as const;

    await expect(client.evaluate(request)).resolves.toMatchObject({
      status: "resolved",
      workspace: "workspace-a",
      version: "v1",
    });
    expect(observedUrl).toBe("https://invariant.example/mcp");
    expect(observedInit?.method).toBe("POST");
    expect(observedInit?.headers).toMatchObject({
      [CF_ACCESS_JWT_ASSERTION_HEADER]: "mcp-secret",
      "MCP-Protocol-Version": "2026-07-28",
    });
    expect(observedInit?.headers).not.toHaveProperty("Authorization");
    const body = JSON.parse(String(observedInit?.body)) as {
      readonly method: string;
      readonly params: { readonly name: string; readonly arguments: typeof request };
    };
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("domain.evaluate");
    expect(body.params.arguments).toEqual(request);
    expect(client.takeLastCall()).toMatchObject({ request, response: { status: "resolved" } });
  });
});

describe('live model completion integrity', () => {
  const config = resolveLiveEvaluationConfig(DEFAULT_LIVE_EVALUATION_CONFIG);
  const answer = { status: 'completed', answer: 'allow', facts: [], constraints: [] };
  const request = { adapter: 'llm-only' as const, prompt: 'Synthetic test',
    fixture: { version: 'evaluation-v0' as const, id: 'synthetic', family: 'threshold' as const, prompt: 'Synthetic test' } };
  it.each(['length', 'content_filter', 'tool_calls', null])('rejects incomplete model output even if its JSON looks valid (%s)', async (finish_reason) => {
    const client = new OpenAICompatibleModel(config, 'synthetic-key', async () => new Response(JSON.stringify({
      choices: [{ finish_reason, message: { content: JSON.stringify(answer) } }],
    })));
    await expect(client.complete(request)).rejects.toThrow();
  });
  it('rejects refusal and multiple choices rather than selecting a convenient answer', async () => {
    const choice = { finish_reason: 'stop', message: { content: JSON.stringify(answer) } };
    for (const choices of [[choice, choice], [{ ...choice, message: { ...choice.message, refusal: 'Refused' } }]]) {
      const client = new OpenAICompatibleModel(config, 'synthetic-key', async () => new Response(JSON.stringify({ choices })));
      await expect(client.complete(request)).rejects.toThrow();
    }
  });
  it('accepts a completed JSON answer and retains the raw completion for review', async () => {
    const payload = { choices: [{ finish_reason: 'stop', message: { refusal: null, content: JSON.stringify(answer) } }] };
    const client = new OpenAICompatibleModel(config, 'synthetic-key', async () => new Response(JSON.stringify(payload)));
    await expect(client.complete(request)).resolves.toEqual(answer);
    expect(client.takeLastCall()?.rawOutput).toEqual(payload);
  });
  it('rejects a body arriving after abort even if a transport ignores cancellation', async () => {
    const client = new OpenAICompatibleModel({ ...config, timeoutMs: 1 }, 'synthetic-key', async (_url, init) => ({
      ok: true, json: async () => {
        await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] };
      },
    } as Response));
    await expect(client.complete(request)).rejects.toThrow('timed out');
  });
  it('does not reuse a prior capture when the next request fails before getting a response', async () => {
    let calls = 0;
    const client = new OpenAICompatibleModel(config, 'synthetic-key', async () => {
      if (calls++) throw new Error('Synthetic transport failure');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
    await client.complete(request);
    await expect(client.complete({ ...request, prompt: 'Second request' })).rejects.toThrow();
    expect(client.takeLastCall()?.request).toMatchObject({ prompt: 'Second request' });
  });
  it('records the prompt actually sent even if the caller changes its object during fetch', async () => {
    const mutable = { ...request, prompt: 'Original prompt' };
    const client = new OpenAICompatibleModel(config, 'synthetic-key', async () => {
      mutable.prompt = 'Changed after send';
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
    await client.complete(mutable);
    expect(client.takeLastCall()?.request.prompt).toBe('Original prompt');
  });
});

describe('live MCP response integrity', () => {
  const config = resolveLiveEvaluationConfig(DEFAULT_LIVE_EVALUATION_CONFIG);
  const request = { workspace: 'w', domain: 'd', version: 'v1', function: 'member-age', args: { user: { age: 20 } } };
  const content = [{ type: 'text', text: JSON.stringify({ status: 'resolved', decision: 'allow' }) }];
  it.each([
    { jsonrpc: '2.0', id: 1, result: { isError: true, content } },
    { jsonrpc: '2.0', id: 2, result: { content } },
    { jsonrpc: '2.0', id: 1, result: { content: [...content, ...content] } },
    { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'not JSON' }] } },
  ])('does not use an invalid tool envelope as evidence: %j', async (payload) => {
    const client = new HttpInvariantToolClient(config, 'synthetic-token', async () => new Response(JSON.stringify(payload)));
    await expect(client.evaluate(request)).rejects.toThrow();
  });
  it('does not accept a late MCP body after timeout', async () => {
    const client = new HttpInvariantToolClient({ ...config, timeoutMs: 1 }, 'synthetic-token', async (_url, init) => ({
      ok: true, json: async () => {
        await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return { jsonrpc: '2.0', id: 1, result: { content } };
      },
    } as Response));
    await expect(client.evaluate(request)).rejects.toThrow('timed out');
  });
  it('can consume the actual current MCP handler rather than only a handcrafted envelope', async () => {
    const model = parseDomainOrThrow(catalog);
    const client = new HttpInvariantToolClient(config, 'synthetic-token', async (url, init) => handleMcpRequest(
      new Request(String(url), init), { INVARIANT_ENVIRONMENT: 'test', MCP_AUTH_MODE: 'test-bypass' }, {
        workspaceRepository: { forPrincipal: async (_principal, workspaceId) => ({
          loadVersion: async (input) => ({ workspaceId, domainId: input.domainId, versionId: input.versionId, model, publishedAt: '2026-01-01T00:00:00Z' }),
          search: async () => [],
        }) },
      },
    ));
    await expect(client.evaluate(request)).resolves.toMatchObject({ status: 'resolved', decision: 'allow' });
  });
  it('records the arguments actually sent rather than a subsequently edited caller object', async () => {
    const mutable = structuredClone(request);
    const client = new HttpInvariantToolClient(config, 'synthetic-token', async () => {
      mutable.args.user.age = 99;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content } }));
    });
    await client.evaluate(mutable);
    expect(client.takeLastCall()?.request.args).toEqual({ user: { age: 20 } });
  });
});
