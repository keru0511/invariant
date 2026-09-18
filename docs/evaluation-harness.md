# Offline evaluation harness

The v0 harness lives in `src/domain/evaluation.ts` and uses the versioned cases
under `fixtures/evaluation-v0/`. The fixture set covers exception handling,
missing facts, thresholds, long-context constraints, and recommendation drift.

Each fixture contains an independent expected answer and required evidence.
`scoreResponse()` never trusts a model-provided score. It classifies a response
as `correct`, `wrong`, `unknown`, `invented`, or `invalid`, with missing and
timeout episodes retained as explicit episode states in the saved trial record.

`llmOnlyAdapter` sends a fixture prompt to an `EvaluationModel`; the
`llmInvariantAdapter` also supplies the fixture's known facts and constraints.
Neither adapter performs a live call itself. Production integrations can
implement `EvaluationModel`; tests should use `RecordedResponseSource` or an
equivalent deterministic fake.

Trial records are JSON serializable with `serializeTrialRecord()` and reloadable
with `deserializeTrialRecord()`. `rescoreTrial()` and `rescoreSavedTrial()` use
only the saved response and fixture, so rescore does not invoke an adapter,
network, clock, or credentials.

Normal verification:

```sh
npm run typecheck
npm test
```

No paid or live model call is part of the normal test suite. Credential-backed
integration calls remain an explicit future action outside this PR.
