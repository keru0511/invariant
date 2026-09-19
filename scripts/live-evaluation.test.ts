import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_EVALUATION_CONFIG, resolveLiveEvaluationConfig } from "../src/domain/live-evaluation";
import {
  CF_ACCESS_JWT_ASSERTION_HEADER,
  HttpInvariantToolClient,
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
      "MCP-Protocol-Version": "2025-06-18",
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
