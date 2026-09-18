# Domain evaluator

`src/domain/evaluator.ts` exposes the pure v0 entry point:

```ts
evaluate(domain, functionName, args)
```

`domain` may be the raw #23 function catalog or a catalog returned by
`parseDomain`. The evaluator validates the catalog with the #24 boundary before
selecting exactly one function by its `name`. Arguments are a JSON-like object
whose leaves must match the function's declared input paths and types.

Evaluation is three-valued for conditions: `true`, `false`, or `unresolved`.
Missing facts remain unresolved. Rules with false conditions are ignored;
unresolved or true conditions at the highest priority block lower-priority
fall-through. Same-priority allow/deny matches return `conflict`. A default
policy decision returns allow/deny only when no rule matches.

Every result has an explicit status (`allow`, `deny`, `unresolved`,
`conflict`, or `error`), a stable trace, and provenance. Invalid function names,
argument shapes/types, domain cycles, argument cycles, and excessive nesting
return `error` with a specific error code. The evaluator does not throw for
these normal validation failures, mutate caller-owned data, or access network,
storage, time, Worker APIs, or an LLM.

The trace is derived only from the parsed function id, node ids, rule ids, and
fixed traversal order. A direct call uses the stable provenance sentinel
`fixtureId: "evaluation"`, because it does not have a golden-fixture id.
