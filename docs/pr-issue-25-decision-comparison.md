# [v0] Detect recommendation drift

`compareDecisionRecords(before, after)` compares two validated `DecisionRecord`
snapshots without trusting caller-provided diff metadata.

## Result statuses

- `consistent`: same domain version, semantic context, and recommendation. Evaluation
  status, result, and trace drift is kept separate from recommendation drift.
- `inconsistent`: same version and context, but the recommendation changed.
- `inputs_changed`: the version is the same and the context changed. `changed_inputs`
  is a deterministic list of fact, constraint, objective-weight, unknown,
  out-of-scope, and alternative
  changes with `before` and `after` values.
- `not_comparable`: the domain versions differ.

Facts compare by value, constraints, unknowns, and alternatives by description;
objectives by weight; and out-of-scope entries by set membership. IDs are sorted
within each category and categories have a stable order, so repeated comparisons
produce byte-identical JSON. Missing entities use `null` as their side of a diff.
Unresolved, ambiguous, conflict, and error evaluation statuses, results, traces,
and explicit null recommendations remain unchanged in the records. The comparison
does not parse evaluation messages: result/trace/evaluation drift is distinct from
recommendation drift when the recommendation ID is unchanged.

The comparison derives its input-change result from every `DecisionContext`
collection, including `unknowns` and `outOfScope`. `changed_inputs` and
`changedInputs` properties supplied alongside a record are discarded before
validation and cannot override computed truth. When the context is unchanged,
recommendation drift is determined only from `recommendationId`; evaluation
result and trace changes are not recommendation drift. `DecisionRecord` preserves
resolved, unresolved, ambiguous, and conflict states with a null recommendation
for every non-resolved state, including evaluator errors.
