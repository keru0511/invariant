# [v0] Detect recommendation drift

`compareDecisionRecords(before, after)` compares two validated `DecisionRecord`
snapshots without trusting caller-provided diff metadata.

## Result statuses

- `consistent`: same domain version, semantic context, recommendation, and evaluation.
- `inconsistent`: same version and context, but the recommendation or evaluation changed.
- `inputs_changed`: the version is the same and the context changed. `changed_inputs`
  is a deterministic list of fact, constraint, objective-weight, and alternative
  changes with `before` and `after` values.
- `not_comparable`: the domain versions differ.

Facts compare by value, constraints and alternatives by description, and
objectives by weight. IDs are sorted within each category and categories have a
stable order, so repeated comparisons produce byte-identical JSON. Missing
entities use `null` as their side of a diff. Unresolved evaluation status,
results, and explicit null recommendations remain unchanged in the records.

The comparison derives its result from the validated snapshots. `changed_inputs`
and `changedInputs` properties supplied alongside a record are discarded before
validation and cannot override computed truth.
