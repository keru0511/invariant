import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'keru0511/Invariant';
export const BASE_BRANCH = 'main';
export const REMOTE_NAME = 'origin';
export const PR_VIEW_FIELDS = 'title,body,baseRefName,headRefName,headRefOid,isDraft,state,url';

const OBJECT_ID_LENGTHS = new Set([40, 64]);

export class PrCreateError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'PrCreateError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new PrCreateError(code, message, cause);
}

function isObjectId(value) {
  return OBJECT_ID_LENGTHS.has(value.length) && /^[0-9a-f]+$/.test(value);
}

export function parsePrCreateArgs(argv) {
  if (!Array.isArray(argv)) fail('invalid-argv', 'argv must be an array');

  let title;
  let bodyFile;
  let draft = false;
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--draft') {
      if (seen.has(token)) fail('duplicate-flag', 'duplicate --draft flag');
      seen.add(token);
      draft = true;
      continue;
    }

    const valueFlag = token === '--title' || token === '--body-file';
    if (!valueFlag) {
      fail('unknown-flag', `unknown or unsupported argument: ${String(token)}`);
    }

    if (seen.has(token)) fail('duplicate-flag', `duplicate ${token} flag`);
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      fail('missing-value', `${token} requires one value`);
    }
    seen.add(token);
    index += 1;
    if (token === '--title') title = value;
    else bodyFile = value;
  }

  if (title === undefined) fail('missing-title', '--title is required');
  if (title.length === 0) fail('empty-title', '--title must not be empty');
  if (bodyFile === undefined) fail('missing-body-file', '--body-file is required');

  return { title, bodyFile, draft };
}

export function runFile(command, args, {
  cwd,
  env = process.env,
  inherit = false,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  return {
    command,
    args: [...args],
    cwd,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error ?? null,
  };
}

function normalizeResult(result) {
  return {
    exitCode: typeof result?.exitCode === 'number'
      ? result.exitCode
      : typeof result?.status === 'number'
        ? result.status
        : null,
    signal: result?.signal ?? null,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
    error: result?.error ?? null,
  };
}

function commandLabel(command, args) {
  return JSON.stringify([command, ...args]);
}

function preview(value) {
  const text = String(value ?? '').trim();
  if (!text) return '<empty>';
  const compact = text.replace(/\r?\n/g, '\\n');
  return compact.length > 240 ? compact.slice(0, 237) + '...' : compact;
}

function resultActual(result) {
  const exit = result.exitCode === null ? 'no exit code' : `exit ${result.exitCode}`;
  const signal = result.signal ? `, signal ${result.signal}` : '';
  const error = result.error ? `, error ${result.error.message || result.error}` : '';
  const output = result.stdout.trim() || result.stderr.trim();
  return `${exit}${signal}${error}; output=${JSON.stringify(preview(output))}`;
}

function escapeTable(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function recordCommand(records, command, args, result, expected) {
  const actual = resultActual(result);
  records.push({
    command,
    args: [...args],
    exitCode: result.exitCode,
    expected,
    actual,
  });
  return result;
}

function invoke(run, records, command, args, options, expected) {
  const result = normalizeResult(run(command, args, options));
  return recordCommand(records, command, args, result, expected);
}

function requireSuccessful(result, code, command, expected = 'exit 0') {
  if (result.exitCode !== 0) {
    const detail = result.error?.message || result.stderr.trim() || result.signal || 'command failed';
    fail(code, `${command} expected ${expected}; actual ${resultActual(result)} (${detail})`);
  }
}

function outputText(result, code, description) {
  requireSuccessful(result, code, description);
  return result.stdout.trim();
}

function appendVerification(body, {
  branch,
  headSha,
  remoteSha,
  draft,
  records,
}) {
  const original = body.endsWith('\n') ? body : body + '\n';
  const rows = records.map((record) => [
    `\`${escapeTable(commandLabel(record.command, record.args))}\``,
    record.exitCode === null ? '<none>' : String(record.exitCode),
    escapeTable(record.expected),
    escapeTable(record.actual),
  ]);
  const table = [
    '| Parsed argv | Exit code | Expected | Actual |',
    '| --- | ---: | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

  return `${original}
## pr:create verification

- Verified commit: \`${headSha}\`
- Expected: a clean worktree, \`${REMOTE_NAME}/${branch}\` at the verified commit, a successful #19 local gate, and one open PR targeting \`${BASE_BRANCH}\`.
- Actual: \`${REMOTE_NAME}/${branch}\` resolved to \`${remoteSha}\`; #19 local gate exited 0; PR creation was requested with head \`${branch}\`, base \`${BASE_BRANCH}\`, and ${draft ? 'draft' : 'ready-for-review'} state.

### Commands run before PR creation

${table}

### Unexecuted items

- No push was performed by this command; the branch had to be pushed already.
- No merge, approval, or post-creation CI rerun was performed.
`;
}

function readRemoteBranchSha(result, branch) {
  const output = result.stdout.trim();
  if (!output) fail('remote-branch-missing', `remote branch ${REMOTE_NAME}/${branch} is missing`);
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) fail('remote-branch-invalid', `remote branch lookup returned ${lines.length} records`);
  const fields = lines[0].split(/\s+/);
  const expectedRef = `refs/heads/${branch}`;
  if (fields.length !== 2 || fields[1] !== expectedRef || !isObjectId(fields[0])) {
    fail('remote-branch-invalid', `remote branch lookup did not return ${expectedRef}`);
  }
  return fields[0];
}

function assertRemoteMatches(result, branch, headSha) {
  requireSuccessful(result, 'remote-branch-missing', `git ls-remote ${REMOTE_NAME} ${branch}`);
  const remoteSha = readRemoteBranchSha(result, branch);
  if (remoteSha !== headSha) {
    fail(
      'stale-remote-branch',
      `remote branch ${REMOTE_NAME}/${branch} is stale: expected ${headSha}, actual ${remoteSha}`,
    );
  }
  return remoteSha;
}

function parsePullRequestUrl(result) {
  const output = result.stdout.trim();
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const url = lines.at(-1);
  if (!url || !/^https:\/\/github\.com\/keru0511\/Invariant\/pull\/\d+$/.test(url)) {
    fail('create-output-invalid', `gh pr create did not return a PR URL: ${JSON.stringify(preview(output))}`);
  }
  return url;
}

function parseReadBack(result) {
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    fail('readback-invalid', `gh pr view returned invalid JSON: ${preview(result.stdout)}`, error);
  }
  if (!value || typeof value !== 'object') fail('readback-invalid', 'gh pr view returned a non-object');
  return value;
}

function assertReadBack(actual, expected, { prUrl } = {}) {
  if (actual.headRefOid !== expected.headRefOid) {
    fail(
      'readback-head-mismatch',
      `PR ${prUrl || '<unknown>'} headRefOid mismatch: expected ${expected.headRefOid}, actual ${actual.headRefOid || '<missing>'}`,
    );
  }
  const mismatches = Object.keys(expected)
    .filter((key) => key !== 'headRefOid')
    .filter((key) => actual[key] !== expected[key])
    .map((key) => `${key}: expected ${JSON.stringify(expected[key])}, actual ${JSON.stringify(actual[key])}`);
  if (mismatches.length > 0) {
    fail('readback-mismatch', `PR read-back mismatch; ${mismatches.join('; ')}`);
  }
}


function npmCommandForPlatform() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function assertPostCreateRemoteMatches(result, branch, headSha, prUrl) {
  try {
    return assertRemoteMatches(result, branch, headSha);
  } catch (error) {
    fail(
      'post-create-remote-mismatch',
      `PR ${prUrl} remote branch ${REMOTE_NAME}/${branch} changed or became unverifiable after creation: ${error.message}`,
      error,
    );
  }
}



export function createTemporaryBodyFile(body) {
  const directory = mkdtempSync(join(tmpdir(), 'invariant-pr-create-'));
  const path = join(directory, 'body.md');
  writeFileSync(path, body, 'utf8');
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function runPrCreate({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  run = runFile,
  readFile = (path) => readFileSync(path, 'utf8'),
  makeBodyFile = createTemporaryBodyFile,
  npmCommand = npmCommandForPlatform(),
  ghCommand = 'gh',
  env = process.env,
} = {}) {
  const options = parsePrCreateArgs(argv);
  const bodyPath = resolve(cwd, options.bodyFile);
  let body;
  try {
    body = readFile(bodyPath);
  } catch (error) {
    fail('body-file-missing', `cannot read --body-file ${bodyPath}`, error);
  }
  if (typeof body !== 'string') fail('body-file-invalid', '--body-file must contain UTF-8 text');

  const records = [];
  const repoResult = invoke(
    run,
    records,
    'git',
    ['rev-parse', '--show-toplevel'],
    { cwd, env },
    'exit 0 and repository root on stdout',
  );
  const repoRoot = resolve(outputText(repoResult, 'repo-not-found', 'git rev-parse --show-toplevel'));

  const statusArgs = ['status', '--porcelain=v1', '--untracked-files=all'];
  const statusResult = invoke(
    run,
    records,
    'git',
    statusArgs,
    { cwd: repoRoot, env },
    'exit 0 and empty porcelain output',
  );
  requireSuccessful(statusResult, 'status-failed', 'git status');
  if (statusResult.stdout.trim() !== '') {
    fail('dirty-worktree', `worktree is dirty: ${preview(statusResult.stdout)}`);
  }

  const branchResult = invoke(
    run,
    records,
    'git',
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    { cwd: repoRoot, env },
    'exit 0 and a named current branch',
  );
  const branch = outputText(branchResult, 'detached-head', 'git symbolic-ref --quiet --short HEAD');
  if (!branch) fail('detached-head', 'HEAD is detached; a named current branch is required');

  const headResult = invoke(
    run,
    records,
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    { cwd: repoRoot, env },
    'exit 0 and the full local HEAD SHA',
  );
  const headSha = outputText(headResult, 'head-unavailable', 'git rev-parse --verify HEAD');
  if (!isObjectId(headSha)) fail('head-invalid', `local HEAD is not a full object ID: ${headSha}`);

  const remoteArgs = ['ls-remote', '--heads', REMOTE_NAME, `refs/heads/${branch}`];
  const remoteResult = invoke(
    run,
    records,
    'git',
    remoteArgs,
    { cwd: repoRoot, env },
    `exit 0 and ${REMOTE_NAME}/${branch} at ${headSha}`,
  );
  const remoteSha = assertRemoteMatches(remoteResult, branch, headSha);

  const gateResult = invoke(
    run,
    records,
    npmCommand,
    ['run', 'ci:local'],
    { cwd: repoRoot, env, inherit: true },
    'exit 0 (#19 local CI gate passes)',
  );
  requireSuccessful(gateResult, 'gate-failed', 'npm run ci:local', '#19 local CI gate exit 0');

  const postGateHeadResult = invoke(
    run,
    records,
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    { cwd: repoRoot, env },
    `exit 0 and unchanged HEAD ${headSha}`,
  );
  const postGateHead = outputText(postGateHeadResult, 'head-unavailable', 'post-gate git rev-parse --verify HEAD');
  if (postGateHead !== headSha) {
    fail('head-changed', `HEAD changed during the local gate: expected ${headSha}, actual ${postGateHead}`);
  }

  const postGateStatusResult = invoke(
    run,
    records,
    'git',
    statusArgs,
    { cwd: repoRoot, env },
    'exit 0 and empty porcelain output after #19',
  );
  requireSuccessful(postGateStatusResult, 'status-failed', 'post-gate git status');
  if (postGateStatusResult.stdout.trim() !== '') {
    fail('dirty-worktree', `worktree became dirty during the gate: ${preview(postGateStatusResult.stdout)}`);
  }

  const postGateRemoteResult = invoke(
    run,
    records,
    'git',
    remoteArgs,
    { cwd: repoRoot, env },
    `exit 0 and unchanged ${REMOTE_NAME}/${branch} ${headSha}`,
  );
  const postGateRemote = assertRemoteMatches(postGateRemoteResult, branch, headSha);

  const verifiedBody = appendVerification(body, {
    branch,
    headSha,
    remoteSha: postGateRemote,
    draft: options.draft,
    records,
  });
  const temporaryBody = makeBodyFile(verifiedBody);

  try {
    const createArgs = [
      'pr',
      'create',
      '--repo',
      REPOSITORY,
      '--base',
      BASE_BRANCH,
      '--head',
      branch,
      '--title',
      options.title,
      '--body-file',
      temporaryBody.path,
    ];
    if (options.draft) createArgs.push('--draft');

    const createResult = normalizeResult(run(ghCommand, createArgs, { cwd: repoRoot, env }));
    requireSuccessful(createResult, 'gh-create-failed', 'gh pr create');
    const prUrl = parsePullRequestUrl(createResult);

    const postCreateRemoteResult = invoke(
      run,
      records,
      'git',
      remoteArgs,
      { cwd: repoRoot, env },
      `exit 0 and unchanged ${REMOTE_NAME}/${branch} ${headSha} after ${prUrl}`,
    );
    const postCreateRemoteSha = assertPostCreateRemoteMatches(
      postCreateRemoteResult,
      branch,
      headSha,
      prUrl,
    );

    const readBackArgs = [
      'pr',
      'view',
      prUrl,
      '--repo',
      REPOSITORY,
      '--json',
      PR_VIEW_FIELDS,
    ];
    const readBackResult = normalizeResult(run(ghCommand, readBackArgs, { cwd: repoRoot, env }));
    requireSuccessful(readBackResult, 'readback-failed', 'gh pr view');
    const actual = parseReadBack(readBackResult);
    assertReadBack(actual, {
      title: options.title,
      body: verifiedBody,
      baseRefName: BASE_BRANCH,
      headRefName: branch,
      headRefOid: headSha,
      isDraft: options.draft,
      state: 'OPEN',
      url: prUrl,
    }, { prUrl });

    return {
      repoRoot,
      branch,
      headSha,
      remoteSha: postCreateRemoteSha,
      prUrl,
      draft: options.draft,
      body: verifiedBody,
      commands: records,
    };
  } finally {
    temporaryBody.cleanup?.();
  }
}

export function formatFailure(error) {
  if (error instanceof PrCreateError) return `${error.code}: ${error.message}`;
  return error?.message || String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runPrCreate();
    process.stdout.write(`pr:create: verified ${result.prUrl} at ${result.headSha}\n`);
  } catch (error) {
    process.stderr.write(`pr:create: FAIL: ${formatFailure(error)}\n`);
    process.exitCode = 1;
  }
}
