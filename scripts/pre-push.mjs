import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BRANCH_REF_PREFIX = 'refs/heads/';
const OBJECT_ID_LENGTHS = new Set([40, 64]);

export class PrePushError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'PrePushError';
    this.code = code;
  }
}

function commandError(command, args, result) {
  const detail = result?.stderr?.trim() || result?.error?.message || 'command failed';
  return new PrePushError(
    'git-command-failed',
    command + ' ' + args.join(' ') + ' failed: ' + detail,
    result?.error,
  );
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw commandError('git', args, result);
  }
  return result.stdout.trim();
}

export function discoverRepoRoot(cwd = process.cwd()) {
  return resolve(runGit(['rev-parse', '--show-toplevel'], cwd));
}

export function discoverCurrentBranch(repoRoot) {
  try {
    return runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot);
  } catch (error) {
    if (error instanceof PrePushError && error.code === 'git-command-failed') {
      throw new PrePushError(
        'detached-head',
        'pre-push supports only a named current branch; HEAD is detached',
        error,
      );
    }
    throw error;
  }
}

function failUnsupported(message) {
  throw new PrePushError('unsupported-push', 'unsupported push: ' + message);
}

function isBranchRef(ref) {
  return ref.startsWith(BRANCH_REF_PREFIX) && ref.length > BRANCH_REF_PREFIX.length;
}

function isObjectId(value) {
  return OBJECT_ID_LENGTHS.has(value.length) && /^[0-9a-f]+$/.test(value);
}

function isZeroObjectId(value) {
  return isObjectId(value) && /^0+$/.test(value);
}

export function parsePrePushInput(input, { currentBranch } = {}) {
  const lines = String(input ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 1) {
    failUnsupported(
      lines.length === 0
        ? 'expected exactly one branch update, received no refspec'
        : 'expected exactly one branch update, received ' + lines.length,
    );
  }

  const fields = lines[0].split(/\s+/);
  if (fields.length !== 4) {
    failUnsupported('expected four refspec fields: <local ref> <local sha> <remote ref> <remote sha>');
  }

  const [sourceRef, localSha, remoteRef, remoteSha] = fields;
  const localRef = sourceRef === 'HEAD' && currentBranch !== undefined
    ? BRANCH_REF_PREFIX + currentBranch
    : sourceRef;
  if (!isBranchRef(localRef) || !isBranchRef(remoteRef)) {
    failUnsupported('only refs/heads/* branch refs are supported; tags and other refs are rejected');
  }

  if (localRef !== remoteRef) {
    failUnsupported('local ref ' + localRef + ' must target the same remote ref');
  }

  if (currentBranch !== undefined && localRef !== BRANCH_REF_PREFIX + currentBranch) {
    failUnsupported('only the current branch ' + currentBranch + ' may be pushed in v0');
  }

  if (!isObjectId(localSha) || !isObjectId(remoteSha) || localSha.length !== remoteSha.length) {
    failUnsupported('local and remote object IDs must be matching 40- or 64-character hexadecimal values');
  }

  if (isZeroObjectId(localSha)) {
    failUnsupported('branch deletion is not supported');
  }

  return {
    localRef,
    sourceRef,
    localSha,
    remoteRef,
    remoteSha,
    branch: localRef.slice(BRANCH_REF_PREFIX.length),
    isCreate: isZeroObjectId(remoteSha),
  };
}

function npmCommandForPlatform() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function runLocalGate(repoRoot, {
  npmCommand = npmCommandForPlatform(),
  spawn = spawnSync,
  env = process.env,
} = {}) {
  const result = spawn(npmCommand, ['run', 'ci:local'], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    process.stderr.write('pre-push: could not run npm run ci:local: ' + result.error.message + '\n');
    return 1;
  }

  if (typeof result.status === 'number') {
    return result.status;
  }

  process.stderr.write(
    'pre-push: npm run ci:local terminated' + (result.signal ? ' by ' + result.signal : '') + '\n',
  );
  return 1;
}

export function runPrePushHook({
  cwd = process.cwd(),
  input,
  npmCommand,
  spawn,
  env,
} = {}) {
  const repoRoot = discoverRepoRoot(cwd);
  const currentBranch = discoverCurrentBranch(repoRoot);
  const update = parsePrePushInput(input, { currentBranch });

  process.stderr.write(
    'pre-push: running local CI gate once for ' + update.localRef + ' -> ' + update.remoteRef + '\n',
  );
  return runLocalGate(repoRoot, { npmCommand, spawn, env });
}

export function formatFailure(error) {
  if (error instanceof PrePushError) return error.code + ': ' + error.message;
  return error?.message || String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = readFileSync(0, 'utf8');
    process.exitCode = runPrePushHook({ input });
  } catch (error) {
    process.stderr.write('pre-push: FAIL: ' + formatFailure(error) + '\n');
    process.exitCode = 1;
  }
}
