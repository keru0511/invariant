# [v0] Implement Decision Context and Decision Record

## Summary

- Adds dependency-free pure TypeScript `DecisionContext` and `DecisionRecord` APIs.
- Adds strict runtime validation with the stable `DecisionValidationError` type and error codes.
- Adds immutable, deep-cloned JSON snapshots with `toJSON()` / `fromJSON()` round-tripping.
- Adds focused tests for semantic equality, preserved `false` / `0` / unresolved values, and invalid input.

## Contract

`DecisionContext` is version `0` and contains these required fields:

- `hardConstraints`: identified textual constraints. They have no weight.
- `objectives`: identified textual objectives with finite non-negative `weight` values, including `0`.
- `outOfScope`: unique non-empty strings.
- `facts`: identified values containing only JSON values; `false` and `0` are valid and preserved.
- `unknowns`: identified textual unknowns.
- `alternatives`: identified textual alternatives.

All entity IDs share one namespace across the six collections. Duplicate IDs,
duplicate out-of-scope values, empty values, unsupported versions, non-finite
numbers, cyclic/non-JSON values, and unknown object fields are rejected.

`DecisionRecord` contains `domainVersion`, a `contextSnapshot`, an `evaluation`
(`status`, JSON `result`, and trace), and `recommendationId`. A resolved record
must point at an existing alternative; an unresolved record must use an
explicit `null` recommendation. Trace references are typed and must point at
an entity in the snapshot. Duplicate trace steps/references and dangling
references are rejected.

## Equality rules

- JSON object key order is ignored.
- Context entity collections and `outOfScope` are set-like; they compare by ID
  or string value, regardless of input order.
- Trace entry order is meaningful and must remain equal.
- Reference order inside one trace entry is set-like.
- Optional field presence is retained in JSON and participates in equality.

`toJSON()` returns a frozen snapshot. Constructors copy input values and freeze
nested arrays/objects, so later caller mutation cannot alter a context or
record.

## Verification

Commands run from the stacked worktree:

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | TypeScript check passed |
| `npm test` | 0 | 5 test files, 23 tests passed |
| `git diff --check` | 0 | No whitespace errors |

## Base / branch

- Stacked branch: `codex/issue-8-decision-context-record`
- Intended base: `issue-23-domain-v0-contract`
- The requested base hash `8a9e3627f776a1d99d1163cf9c2451c3c639eafe` is not
  present in the local repository; the local base ref points to `df01d30`.
- No files from the existing #23 implementation were modified.

## Limitations and unexecuted actions

- No push was executed: the local repository has no configured Git remote.
- No hosted stacked PR was created for the same reason and because no GitHub
  integration is available in this workspace. The local branch is ready for a
  PR whose base is `issue-23-domain-v0-contract`.
- No merge, auto-merge, or #18 close action was performed.
- Evaluation remains out of scope: this change stores/validates evaluation
  results and traces but does not calculate them.
- Worker, MCP, storage, LLM, tooling, authentication, and evaluator files were
  intentionally left unchanged.
