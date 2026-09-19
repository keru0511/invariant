# Stored `domain.evaluate` MCP tool

The Worker exposes `domain.evaluate` as a thin stored-domain adapter.
Each call supplies `workspace`, `domain`, `version`, `function`, and `args`.
The verified Access principal is authorized for the requested workspace before
the exact domain/version is loaded.

Domain decisions are preserved: `unresolved`, `ambiguous`, and `conflict`
remain distinct with null values, traces, provenance, and typed errors.
Duplicate function names return `status: "ambiguous"`,
`AMBIGUOUS_MATCH`, and deterministic sorted `matchedFunctionIds`.
Allow/deny decisions are exposed as `status: "resolved"` with `decision`.

Invalid identifiers are rejected before storage; foreign or missing resources
return redacted `RESOURCE_NOT_FOUND`; storage details and credentials are not
returned. Status is taken from the typed Domain result, never inferred from
error-message text. Identical inputs produce stable output and are not mutated.
