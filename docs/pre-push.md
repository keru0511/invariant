# Repository pre-push CI hook

npm run hooks:install enables the version-controlled .githooks/pre-push hook
for the current repository. The command is explicit and idempotent. It sets
only the repository-local core.hooksPath to .githooks; it does not write
global configuration, replace files under .git/hooks, or modify other Git
configuration.

The v0 hook supports one update from the current branch to the same remote
branch. It runs npm run ci:local exactly once for that supported update and
returns the gate's exit status. The hook rejects tags, branch deletion, other
refspecs, multiple updates, detached HEAD, and malformed input before the gate
starts.

The hook parses Git's pre-push stdin as data. It never evaluates a refspec as
shell code.

## Verification record

The following checks are maintained with this implementation:

| Command or scenario | Result |
| --- | --- |
| npm test | exit 0; 56 passed and 2 skipped (the two Node 22-only #19 tests) |
| npm run typecheck | exit 0 |
| npm run hooks:install, repeated | exit 0; configured, then already configured |
| temporary repo: first and later same-branch pushes | covered by hook integration tests |
| temporary bare remote: failing gate leaves remote SHA unchanged | covered by hook integration tests |
| repeated install and unrelated local/global hook config | covered by installer tests |
| linked worktree root discovery | covered by installer/hook tests |
| tag/delete/multiple-update/unsupported refspecs | rejected without starting the gate |
| npm run ci:local | exit 1 as expected: local runtime is Node 24.19.0, while #19 requires Node 22.19.0 |
