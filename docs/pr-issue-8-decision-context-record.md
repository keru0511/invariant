# [v0] Implement Decision Context and Decision Record

## Summary

- Adds dependency-free pure TypeScript `DecisionContext` and `DecisionRecord` APIs.
- Adds strict runtime validation with the stable `DecisionValidationError` type and error codes.
- Adds immutable, deep-cloned JSON snapshots with `toJSON()` / `fromJSON()` round-tripping.
- Adds focused tests for semantic equality, preserved `false` / `0` / evaluation states, and invalid input.

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
(`status`, JSON `result`, and trace), and `recommendationId`. `EvaluationStatus`
preserves `resolved`, `unresolved`, `ambiguous`, and `conflict` as distinct
first-class values. v0 also preserves evaluator failures as `error`; the
Domain v0 error payload is stored in `evaluation.result`. A resolved record
must point at an existing alternative. `unresolved`, `ambiguous`, `conflict`,
and `error` records must use an explicit `null` recommendation. A malformed
record is not represented as an evaluation error: validation throws the stable
`DecisionValidationError` instead. Trace references are typed and must point at
an entity in the snapshot. Duplicate trace steps/references and dangling
references are rejected.

Domain v0 `allow` and `deny` outcomes are stored as `resolved` records with
their domain result payload; its `unresolved` and `conflict` outcomes retain
their own record statuses. An ambiguous record retains the Domain v0
`matchedRuleIds`, `AMBIGUOUS_MATCH` error, trace, and provenance in the JSON
result, rather than collapsing to `unresolved`.

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
| `npm test` | 0 | 5 test files, 26 tests passed |
| `git diff --check` | 0 | No whitespace errors |

## Base / branch

- Branch: `codex/issue-8-decision-context-record`
- Base: `main` at `700a093b6cf321ab4572ab71e475b73d709dd8c9`
- This commit is reconstructed directly from the current main tree.
- The diff contains only the DecisionContext/DecisionRecord implementation,
  their dedicated tests, and this document. Domain v0 contract and fixture
  files already present on main are not copied from the old stacked history.

## Limitations and unexecuted actions

- The branch rewrite was assembled with the Git data API; no local clone
  or local rebase was required.
- No merge, auto-merge, or issue close action was performed.
- Evaluation remains out of scope: this change stores/validates evaluation
  results and traces but does not calculate them.
- Worker, MCP, storage, LLM, tooling, authentication, and evaluator files
  were intentionally left unchanged.
