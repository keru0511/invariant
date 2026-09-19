# Gated PR creation

`npm run pr:create -- --title <text> --body-file <path> [--draft]` creates a
pull request only for the already-pushed current branch revision that passes
the local CI gate.

The command uses the fixed repository `keru0511/Invariant` and base branch
`main`. It reads the current branch from Git, requires a clean worktree, and
requires `origin/<current-branch>` to point to the same full SHA as local
`HEAD`. It then runs `npm run ci:local` and calls `gh pr create` only after
that gate succeeds. It never pushes, merges, or accepts target-changing
flags such as `--repo`, `--base`, or `--head`.

The title and file path are passed as individual process arguments; they are
not evaluated by a shell. The supplied body is copied to a temporary file
with the verified SHA and command-result table appended. After creation, the
command reads the PR back with `gh pr view` and fails closed if the title,
body, base, head, draft state, open state, or URL differs from the expected
values.

The command's test suite uses fake Git, npm, and `gh` runners. Tests never
create a real pull request.

  
After creation, the command rechecks the remote branch and reads the PR back with
`gh pr view --json title,body,baseRefName,headRefName,headRefOid,isDraft,state,url`.
It fails closed with the PR URL if the remote branch moved or if the returned
`headRefOid` differs from the verified SHA. It also rejects title, body, base,
head, draft state, open state, or URL mismatches.
