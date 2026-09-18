# Domain v0 contract

This document is the implementation contract for the dependency-free domain
core. The machine-readable examples are in
[`fixtures/domain-v0/`](../fixtures/domain-v0/), and the corresponding
TypeScript types/constants are in [`src/domain/contract.ts`](../src/domain/contract.ts).

## Scope

v0 defines three synthetic functions only:

- `function.domain-v0.member-age`
- `function.domain-v0.refund`
- `function.domain-v0.account-review`

The catalog in `fixtures/domain-v0/functions.json` is the policy source. A
golden case in `fixtures/domain-v0/cases/` supplies input and an expected
result; no evaluator is needed to review the expected result.

## AST

Every expression node has a stable `id` and one of these `kind` values:

| Kind | Shape | Meaning |
| --- | --- | --- |
| `literal` | `{ id, kind, value }` | A JSON scalar constant. |
| `input` | `{ id, kind, path }` | A value read from a dotted input path. |
| `compare` | `{ id, kind, operator, left, right }` | `eq`, `lt`, `lte`, `gt`, or `gte`; operands must have compatible types. |
| `logical` | `{ id, kind, operator, operands }` | `and` or `or` over two or more conditions. |
| `not` | `{ id, kind, operand }` | Negates a condition. |

Conditions are three-valued: `true`, `false`, or `unresolved`. Missing input
does not become `false` and must not be silently defaulted.

## Policy resolution

Rules have a numeric `priority`, a condition in `when`, and a decision in
`then` (`allow` or `deny`). The v0 resolution algorithm is:

1. Evaluate rules to `true`, `false`, `unresolved`, or `error`.
2. Ignore `false` rules. An `error` is terminal and returns `error`.
3. Among the remaining rules, consider only the highest priority.
4. If a highest-priority condition is `unresolved`, return `unresolved` and
   do not fall through to a lower-priority rule.
5. If highest-priority matching rules contain both `allow` and `deny`, return
   `conflict` with `RULE_CONFLICT`; do not choose by file order.
6. If exactly one decision remains, return `allow` or `deny`. If no rule
   remains, return the policy's `defaultStatus`.

The result uses `value: true` for `allow`, `value: false` for `deny`, and
`value: null` for `unresolved`, `conflict`, or `error`. Errors are structured
objects, not thrown exceptions: v0 uses `MISSING_INPUT`, `TYPE_MISMATCH`,
`RULE_CONFLICT`, and `INVALID_AST`.

## Result, trace, and provenance

Every golden fixture has an `expected` object with:

```json
{
  "status": "allow | deny | unresolved | conflict | error",
  "value": true,
  "matchedRuleIds": [],
  "unresolvedPaths": [],
  "errors": [],
  "trace": [],
  "provenance": {
    "fixtureId": "fixture.domain-v0.example",
    "functionId": "function.domain-v0.example",
    "policyId": "policy.domain-v0.example",
    "inputPaths": [],
    "ruleIds": []
  }
}
```

`trace` is an ordered, stable explanation made of `input`, `literal`,
`operator`, `rule`, and `policy` events. Each event has an opaque stable `id`
and reports its boolean/status outcome. `provenance` identifies the exact
fixture, function, policy, input paths, and rules used to derive the result.

## Fixture coverage

`manifest.json` lists stable fixture IDs and the supported vocabulary. The
tests assert that:

- every listed JSON document parses and every fixture ID is unique;
- all supported node kinds and operators occur in the catalog used by the
  fixtures;
- every result status has at least one golden case; and
- expected values, errors, traces, and provenance have the required shape.

The cases cover valid decisions, the age boundary at `18`, invalid input type,
missing input/unresolved evaluation, and a same-priority allow/deny conflict.
