# Offline evaluation harness

The v0 harness lives in `src/domain/evaluation.ts` and uses the versioned cases
under `fixtures/evaluation-v0/`. The fixture set covers exception handling,
missing facts, thresholds, long-context constraints, and recommendation drift.

Each fixture contains an independent expected answer and required evidence.
`scoreResponse()` never trusts a model-provided score. It classifies a response
as `correct`, `wrong`, `unknown`, `invented`, or `invalid`, with missing and
timeout episodes retained as explicit episode states in the saved trial record.

`llmOnlyAdapter` sends a fixture prompt to an `EvaluationModel`. The
`llmInvariantAdapter` requires an injected `InvariantToolClient`; it sends a
fixture id and prompt through the tool boundary, then supplies only that
client's returned context to the model. Scorer-only fields (`knownFacts`,
`knownConstraints`, and `expected`) are never placed in the model request.
`RecordedInvariantToolClient` is the deterministic offline transcript used by
tests. Neither adapter performs a live call itself.

Each invariant trial stores request/response evidence in the trial record with
prompts and context values redacted while retaining tool/version/fixture ids
and item counts. Production integrations can implement `EvaluationModel` and
`InvariantToolClient`; tests should use `RecordedResponseSource`,
`RecordedInvariantToolClient`, or equivalent deterministic fakes.

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

## 保存データの境界

保存記録の読み込み時にも状態、スコアの型/内部整合性、秘匿済みツール根拠の形を検査します。
読み込んだ記録と再採点の結果は不変のコピーです。呼び出し元のオブジェクトを凍結しません。
形が正しいスコアであっても、その正誤は別問題なので、再採点ではfixtureと保存回答から計算し直します。
