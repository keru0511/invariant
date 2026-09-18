# Live v0 evaluation

The live runner compares the two #15 conditions over the versioned
evaluation-v0 fixtures:

- LLM-only receives the case prompt.
- LLM+Invariant receives the same prompt plus the fixture known facts and
  constraints.

Both paths use the #15 adapters and independent scorer. The provider client is
an OpenAI-compatible chat-completions client. Normal typecheck and test
commands never invoke it.

## Smoke run

The checked-in config has trialsPerCase: 1, which is the small smoke default.
It runs one trial for every fixture in each condition:

    OPENAI_API_KEY=... npm run eval:live:smoke

LIVE_EVAL_API_KEY is accepted as an alternative. The model and endpoint can
be overridden with OPENAI_MODEL, OPENAI_BASE_URL, --model, or --base-url. The
runner fails with a non-zero exit before any provider call when neither
credential variable is set.

For a larger run, set the number of attempts explicitly:

    OPENAI_API_KEY=... npm run eval:live -- --trials 10 --output-dir artifacts/live-evaluation-large

The CLI also accepts --config, --timeout-ms, and --help. A provider error
does not disappear: the command records it and exits non-zero after writing
the report.

## Artifacts

The output directory contains:

- config.json with the effective non-secret configuration;
- trials/*.json with redacted raw provider output, redacted tool calls,
  condition, case, episode status, and independent score;
- report.json with per-condition and per-case aggregates, errors,
  improvements, regressions, and the bounded comparison claim;
- report.md, the same report in a reviewable form.

Credential-shaped fields and bearer/key-looking strings are replaced before
writing. Rescoring uses only the saved response and fixture; it does not call
the provider, filesystem, clock, or network.

No live credentials, deployment, or paid provider call is part of normal CI or
the issue #29 verification run.
