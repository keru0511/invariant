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
| npm test | exit 0; 58 passed |
| npm run typecheck | exit 0 |
| npm run hooks:install, repeated | exit 0 both times; already configured both times in this checkout; fixture covers configure-then-idempotent |
| npm run ci:local | exit 0; CI/quality install, typecheck, tests and run record passed |
| npm run test:ci-gate | exit 0; positive, type-error, and test-failure disposable smoke cases matched expected results |
| temporary repo: first and later same-branch pushes | passed in integration tests; gate called once per push |
| temporary bare remote: failing gate leaves remote SHA unchanged | passed in integration tests |
| repeated install and unrelated local/global hook config | passed in installer tests |
| linked worktree root discovery | passed in installer tests |
| tag/delete/multiple-update/unsupported refspecs | rejected before the gate; passed parser/no-gate tests |

No required command or acceptance scenario is being treated as PASS without an
observed result. A separate `npm ci` command was not run in this final pass;
the existing installed dependencies and the real #19 gate completed
successfully.
