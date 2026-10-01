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
6. If multiple highest-priority rules remain and they all select the same
   decision, return `ambiguous` with `AMBIGUOUS_MATCH`; do not collapse
   multiple candidates into a single allow/deny result.
7. If exactly one decision remains, return `allow` or `deny`. If no rule
   remains, return the policy's `defaultStatus`.

The result uses `value: true` for `allow`, `value: false` for `deny`, and
`value: null` for `unresolved`, `conflict`, `ambiguous`, or `error`. Errors are
structured objects, not thrown exceptions: v0 uses `MISSING_INPUT`,
`TYPE_MISMATCH`, `RULE_CONFLICT`, `AMBIGUOUS_MATCH`, and `INVALID_AST`.

## Result, trace, and provenance

Every golden fixture has an `expected` object with:

```json
{
  "status": "allow | deny | unresolved | conflict | ambiguous | error",
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

The cases include an explicit ambiguous result when same-priority allow rules
leave more than one candidate, distinct from a conflicting allow/deny result.

The cases cover valid decisions, the age boundary at `18`, invalid input type,
missing input/unresolved evaluation, and a same-priority allow/deny conflict.

## Semantic validation

Structural parsing and semantic validation are separate checks. Use
`validateGoldenFixture(fixture, function)` for one fixture or
`validateDomainFixtures(domain, fixtures)` for a catalog and its
fixtures. `parseGoldenFixture(fixture, function)` may be used when parsing and
semantic validation should be one boundary operation.

Semantic failures are typed `DomainParseError` values with stable `code` and
`path` fields. Failed multi-document validation also exposes the complete
`errors` array in deterministic path/code/message order; callers can inspect
all diagnostics without relying on exception text. Validation creates frozen
canonical values and does not mutate or retain caller-owned input objects.

At the highest priority, a matching allow and deny set is a `conflict` with a
`RULE_CONFLICT` diagnostic. Multiple matching rules that all choose the same
decision remain `ambiguous` with an `AMBIGUOUS_MATCH` diagnostic; they are not
silently collapsed into `allow` or `deny`. Same-decision ambiguous rule IDs
are normalized by stable identifier order, while conflict candidates retain
policy order.

## Domain Patch v0

`src/domain/patch.ts` defines a dependency-free, copy-on-write patch boundary
for a domain model. A patch has `contractVersion: "domain-patch-v0"`, kind
`"domain-patch"`, a non-empty `baseVersion`, non-empty `provenance.source`, and
an ordered list of operations. The patch is applied only when `baseVersion`
matches the model version; when the model already has provenance, the complete
patch provenance must match it.

The supported operations are exactly:

- `add_type`
- `add_function`
- `add_rule`
- `add_example`
- `mark_unknown`
- `resolve_unknown`
- `add_conflict`

Operations reject unsupported fields, malformed values, duplicate identifiers,
and missing references. `add_rule` requires an existing function,
`resolve_unknown` requires an existing unknown, and duplicate rule identifiers
are rejected across the catalog. `add_example` is checked against the final
catalog with the semantic validation path above.

Application is atomic: the input model is copied before any operation is
applied, and a failed patch never mutates caller-owned data or returns a
partial candidate. Successful results preserve operation order and are deeply
frozen. Reapplying the same patch to the same base produces the same serialized
result. Final validation retains the Domain v0 distinction between
`unresolved`, `conflict`, `ambiguous`, and `error`.

## 数値表現の制約

v0のnumberはIEEE 754の有限数値です。整数はJavaScriptの安全な整数範囲
（±9007199254740991）に限定し、入力・定数・優先度で範囲外を拒否します。
任意精度の整数/decimalや金額の正確性は、この表現では保証しません。
高精度の値は明示的な型と専用の比較規則を設計してから扱う必要があります。
