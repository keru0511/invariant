import { describe, expect, it } from "vitest";
import { runLiveEvaluationCommand } from "./live-evaluation";

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
    expect(stderr).toContain("no provider call was attempted");
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
  });
});
