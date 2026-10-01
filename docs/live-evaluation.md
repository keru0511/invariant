# Live v0 evaluation

The live runner compares the two #15 conditions over the versioned
evaluation-v0 fixtures:

- LLM-only receives the case prompt.
- LLM+Invariant first calls the authenticated #14 `domain.evaluate` MCP tool
  with explicit `workspace`, `domain`, `version`, `function`, and `args`
  fields. It receives the recorded tool result; fixture `knownFacts` and
  `knownConstraints` are never copied into the model prompt.

The checked-in smoke targets are valid requests for the repository's domain-v0
demo shape. Each of the five `evaluation-v0` cases has an explicit target in
`config/live-evaluation-v0.json`; the targets cover `member-age`, `refund`,
and `account-review` with distinct arguments. The recorded artifact includes
the exact request and response for each case. Use `--config`, `--args-json`,
or the target flags when the authorized deployment uses another stored
workspace/domain/version.

Both paths use the #15 adapters and independent scorer. The provider client is
an OpenAI-compatible chat-completions client and the Invariant client is a
JSON-RPC/MCP HTTP client. Normal typecheck and test commands never invoke
either network client.

## Smoke run

The checked-in config has trialsPerCase: 1, which is the small smoke default.
It runs one trial for every fixture in each condition:

    OPENAI_API_KEY=... LIVE_EVAL_MCP_TOKEN=... npm run eval:live:smoke

LIVE_EVAL_API_KEY is accepted as an alternative. The model and endpoint can
be overridden with OPENAI_MODEL, OPENAI_BASE_URL, --model, or --base-url. The
runner also needs `LIVE_EVAL_MCP_TOKEN` (or `INVARIANT_MCP_TOKEN`) for the
authenticated MCP endpoint. The token is a Cloudflare Access JWT sent as
`Cf-Access-Jwt-Assertion`, matching the Worker verifier; it is not sent as a
Bearer `Authorization` header. `LIVE_EVAL_MCP_URL`, `LIVE_EVAL_WORKSPACE`,
`LIVE_EVAL_DOMAIN`, `LIVE_EVAL_DOMAIN_VERSION`, and `LIVE_EVAL_DOMAIN_FUNCTION`
override the stored-tool target. Use `--args-json` or a config file to change
the function arguments. Missing provider or MCP credentials fail with exit code
2 before either network call.

For a larger run, set the number of attempts explicitly:

    OPENAI_API_KEY=... npm run eval:live -- --trials 10 --output-dir artifacts/live-evaluation-large

The CLI also accepts --config, --timeout-ms, and --help. A provider error
does not disappear: the command records it and exits non-zero after writing
the report.

## Artifacts

The output directory contains:

- config.json with the effective non-secret configuration;
- trials/*.json with redacted raw provider output, redacted model tool calls,
  the actual redacted `domain.evaluate` request/response, condition, case,
  episode status, and independent score;
- report.json with per-condition and per-case aggregates, errors,
  improvements, regressions, and the bounded comparison claim;
- report.md, the same report in a reviewable form.

Credential-shaped fields and bearer/key-looking strings are replaced before
writing. Rescoring uses only the saved response and fixture; it does not call
the provider, MCP endpoint, filesystem, clock, or network.

No live credentials, deployment, or paid provider call is part of normal CI or
the issue #29 verification run.

## 応答を誤って成功としないための検証

評価用クライアントも、生成打ち切り・拒否・複数候補・JSON回答で要求していないtool_callsを受理しません。
finish_reasonを返すproviderではstopのみを受理します。互換providerがこの欄を省略した場合は従来どおり受理するため、終了理由までは検証できません。
タイムアウト後に到着した本文は、内容が正しいJSONでも成功にしません。次の通信失敗に前回の記録を流用しません。

MCP側は現在の2026-07-28プロトコルとメタデータを使い、実サーバーハンドラーとの接続もテストします。
JSON-RPCの応答ID、tool error、本文の形を検査し、エラーを評価根拠に流しません。
これらの通常テストは通信を差し替え、実providerや課金APIを呼びません。

## 保存記録の再集計

保存JSONの自己申告scoreを集計の根拠にはしません。宣言したfixtureの正解と保存responseから再採点します。
試行ID・状態・件数の型を検査し、重複試行、対象外fixture、重複fixture定義を拒否します。
読み込んだ記録は不変にします。rawOutputは監査資料であり、その文字列を命令として実行しません。

passRateは採点できた試行だけが分母です。通信エラーが多い場合の過大評価を避けるため、
overallPassRate（正答/記録された全試行）とscoringCoverage（採点済/記録された全試行）も表示します。
渡されなかった記録の存在までは検出できません。指標は記録された試行の範囲に限定され、全体性能の保証ではありません。

評価回答のJSONも閉じた契約として扱い、completedではstatus/answer/facts/constraints、
missing/timeoutではstatus/reason以外の欄を拒否します。未採点の説明欄に追加主張があっても、全体をcorrectとは認定しません。
自由文そのものの真偽判定を実装したわけではなく、この評価形式の外側は採点対象外です。
