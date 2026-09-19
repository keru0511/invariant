# Hosted CI and deployment boundary

Issue #4 keeps `.github/workflows/ci.yml` as a validation-only workflow. It runs one `quality` job for pull requests targeting `main`, manual dispatches, and the explicitly inert push trigger used by the local actrun gate. The workflow has no deployment step, Cloudflare action, production secret, or write permission.

## Required check for `main`

For the #22 repository settings, add the check produced by workflow `CI` and job `quality` to the `main` branch protection rule or ruleset. GitHub commonly displays this check as `CI / quality`; select the exact `quality` check offered by GitHub rather than a similarly named check from another workflow.

Require the check for a pull request before merge. Do not require a push-only check: ordinary branch pushes intentionally do not start this workflow, so a pull request is the single hosted validation path.

## Cloudflare deployment for #22

Keep deployment in a separate #22 workflow, for example `.github/workflows/deploy.yml`, with its own explicit trigger and environment. That workflow should:

1. depend on the successful `CI / quality` result before deploying;
2. use a protected `production` GitHub Environment with the required approval policy;
3. store only the least-privileged Cloudflare token and account identifier in that environment; and
4. restrict deployment to the intended protected branch or an approved release event.

Do not add Cloudflare credentials, `wrangler deploy`, or deployment permissions to `ci.yml`. This separation keeps pull-request CI read-only and prevents untrusted pull-request code from receiving production access.
