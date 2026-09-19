import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const DESIRED_HOOKS_PATH = '.githooks';

export class HooksInstallError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'HooksInstallError';
    this.code = code;
  }
}

async function runGit(args, cwd) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || 'command failed';
    throw new HooksInstallError(
      'git-command-failed',
      'git ' + args.join(' ') + ' failed: ' + detail,
      error,
    );
  }
}

export async function discoverRepoRoot(cwd = process.cwd()) {
  return resolve(await runGit(['rev-parse', '--show-toplevel'], cwd));
}

async function readLocalHooksPath(repoRoot) {
  try {
    const result = await execFileAsync(
      'git',
      ['config', '--local', '--get-all', 'core.hooksPath'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return result.stdout.trim().split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error?.code === 1) return [];
    const detail = error?.stderr?.trim() || error?.message || 'command failed';
    throw new HooksInstallError(
      'git-command-failed',
      'git config --local --get-all core.hooksPath failed: ' + detail,
      error,
    );
  }
}

function isEquivalentHooksPath(configured, repoRoot) {
  if (!configured) return false;
  return resolve(repoRoot, configured) === join(repoRoot, DESIRED_HOOKS_PATH);
}

export async function installHooks(cwd = process.cwd()) {
  const repoRoot = await discoverRepoRoot(cwd);
  const hookPath = join(repoRoot, DESIRED_HOOKS_PATH, 'pre-push');

  try {
    await access(hookPath, constants.X_OK);
  } catch (error) {
    throw new HooksInstallError(
      'hook-missing',
      'version-controlled executable hook is missing at ' + hookPath,
      error,
    );
  }

  const configuredPaths = await readLocalHooksPath(repoRoot);
  const effectivePath = configuredPaths.at(-1);
  const alreadyInstalled = isEquivalentHooksPath(effectivePath, repoRoot);

  if (!alreadyInstalled) {
    await runGit(
      ['config', '--local', '--replace-all', 'core.hooksPath', DESIRED_HOOKS_PATH],
      repoRoot,
    );
  }

  return {
    repoRoot,
    hookPath,
    hooksPath: DESIRED_HOOKS_PATH,
    changed: !alreadyInstalled,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await installHooks();
    process.stdout.write(
      'hooks:install: ' + (result.changed ? 'configured' : 'already configured')
        + ' local core.hooksPath=' + result.hooksPath + '\n',
    );
  } catch (error) {
    const message = error instanceof HooksInstallError
      ? error.code + ': ' + error.message
      : error?.message || String(error);
    process.stderr.write('hooks:install: FAIL: ' + message + '\n');
    process.exitCode = 1;
  }
}
