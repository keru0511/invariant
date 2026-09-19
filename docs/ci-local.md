# Local CI gate

`npm run ci:local` is the only local entrypoint. It accepts no runner flags. A successful exit requires a new, unique actrun record for the captured commit, the `CI` workflow, the `quality` job, and the `install`, `typecheck`, and `tests` steps.

## Fixed toolchain

| Item | Pin or revision |
| --- | --- |
| OS target | Linux/macOS developer environments; smoke evidence in this PR is Linux x86_64 only |
| Node | `24.19.0` in `.node-version` |
| npm | `11.9.0` |
| `@mizchi/actrun` | exact `0.32.0` in `package.json` and `package-lock.json` (Node `>=18`) |
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683` (`v4.2.2`) |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` (`v4.4.0`) |

The approved dual-trigger workflow retains `workflow_dispatch` for manual GitHub runs and adds `push` with `branches-ignore: ['**']`. GitHub therefore does not run the workflow for ordinary branch pushes, while the local gate explicitly invokes actrun with `--trigger push`. actrun 0.32.0 reports that it skips trigger matching for this explicit local event. The local `actrun.toml` skips the two setup actions because the gate has already created a detached snapshot and has checked the exact Node version plus an npm major compatible with the pinned setup step. Both hosted GitHub Actions and local actrun then execute the same `npm install --global npm@11.9.0` toolchain step before `npm ci`.

The wrapper validates this workflow shape before creating a snapshot. `ACTION_REVISIONS` is an allowlist, not documentation only: `actions/checkout` and `actions/setup-node` must each occur exactly once and must use the exact full SHAs above. Tag or branch refs, another SHA, a missing or duplicate action step, any other `uses` entry, and any extra job or step fail closed with `workflow-contract`. The approved workflow has exactly one `quality` job and the ordered steps `checkout`, `setup-node`, `npm`, `install`, `typecheck`, and `tests`; no other action is accepted. The `npm` step installs and verifies the exact npm `11.9.0` pin before any quality command.

## Gate invariants

Before the runner starts, the wrapper:

1. validates the committed workflow contract;
2. rejects staged, unstaged, non-ignored untracked, and undeclared ignored paths;
3. captures `git rev-parse HEAD`;
4. verifies the exact Node, a usable npm 11 preflight, package manifest, lockfile, and caller-installed actrun binary; the shared workflow pins npm `11.9.0` before install;
5. creates a detached temporary worktree at the captured SHA; and
6. launches that snapshot with actrun's `worktree` workspace mode.

After the runner exits, it requires a single new `run.json` in the per-invocation run root. It verifies the exact `run_id`, workflow, event, workspace mode, `headSha`, process/record exit codes, job, task, and mandatory step results. It then checks the caller's HEAD and cleanliness again. There is no latest-run lookup, retry, affected-only mode, dry-run, stash, reset, auto-fix, or runner fallback.

The only ignored paths declared for the gate are `node_modules/`, `.actrun-runs/`, and `_build/`.

## Tests

`npm test` runs the wrapper/unit and fixture-contract tests. The active-run mutation and SIGINT-preservation fixtures run when the exact supported local Node `24.19.0` is active; they are skipped on other Node versions and are never reported as PASS from a skipped run. `npm run test:ci-gate` is separate and invokes the real pinned actrun in disposable fixture repositories. Fixtures do not contain the gate integration harness, so there is no `npm test -> ci:local -> npm test` recursion.

The fixture smoke uses the committed dual-trigger shape and explicitly passes `--trigger push`. It checks the positive run record and two intentional failures; it does not treat a log substring as success.

## Bootstrap compatibility evidence

The required bootstrap was run with `@mizchi/actrun@0.32.0` on Linux x86_64, Node `v24.19.0`, npm `11.9.0`, and git `2.51.1`.

Command used for the candidate workflow:

```text
node node_modules/@mizchi/actrun/dist/actrun.js \
  workflow run .github/workflows/ci.yml \
  --trigger push \
  --run-root .actrun-runs
```

For the approved dual-trigger workflow (`workflow_dispatch` plus `push.branches-ignore: ['**']`), actrun explicitly invoked with `--trigger push` produced a run record. It prints:

```text
trigger: using push (trigger matching skipped)
```

The success fixture exited `0` with a new `run-1` record and successful job/step results. The failure fixture exited `1`, reached its intended failing step with code `7`, and recorded the job as failed. These bootstrap records are retained outside the repository and are not used as the gate's pass cache.

For comparison, explicit `workflow_dispatch` on the same candidate exits `1` with:

```text
error: only push and workflow_call triggers are supported in MVP
```

No run record was created. The documented `--trigger workflow_dispatch` flag was also checked with the same approved workflow and produced the same exit code and error; it does not make the unsupported trigger executable. The implementation therefore fails closed with a missing-run-record diagnostic. It does not change the workflow trigger, change actrun versions, or infer undocumented record fields.

That unsupported path is not used by the local gate. The approved dual-trigger workflow is the shared #19 contract for hosted manual execution and local actrun execution.
