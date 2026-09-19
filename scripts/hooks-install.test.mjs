import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { installHooks } from './hooks-install.mjs';

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function run(command, args, cwd, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolvePromise({ exitCode: null, stdout, stderr, error }));
    child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal, stdout, stderr, error: null }));
  });
}

async function createInstallFixture() {
  const root = await temporaryDirectory('invariant-hooks-install-');
  await mkdir(join(root, '.githooks'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'nested'), { recursive: true });
  await copyFile(join(sourceRoot, '.githooks/pre-push'), join(root, '.githooks/pre-push'));
  await copyFile(join(sourceRoot, 'scripts/hooks-install.mjs'), join(root, 'scripts/hooks-install.mjs'));
  await chmod(join(root, '.githooks/pre-push'), 0o755);
  await run('git', ['init', '-q', '-b', 'main'], root);
  await run('git', ['config', 'user.email', 'hook-test@example.invalid'], root);
  await run('git', ['config', 'user.name', 'hook-test'], root);
  await writeFile(join(root, 'README'), 'fixture\n');
  await run('git', ['add', '.'], root);
  await run('git', ['commit', '-qm', 'fixture'], root);
  return root;
}

describe('hooks:install', () => {
  it('sets local core.hooksPath idempotently while preserving unrelated config and hooks', async () => {
    const root = await createInstallFixture();
    const globalConfig = join(root, 'global.gitconfig');
    const existingHook = join(root, '.git/hooks/pre-commit');
    const isolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
    await writeFile(existingHook, '#!/bin/sh\nprintf unrelated\n');
    await chmod(existingHook, 0o755);
    await run('git', ['config', '--local', 'user.signingkey', 'fixture-key'], root);
    await run('git', ['config', '--global', 'core.hooksPath', 'global-hooks'], root, { env: isolatedEnv });

    const first = await installHooks(join(root, 'nested'));
    const configAfterFirst = await readFile(join(root, '.git/config'), 'utf8');
    const second = await installHooks(root);
    const configAfterSecond = await readFile(join(root, '.git/config'), 'utf8');

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(configAfterSecond).toBe(configAfterFirst);
    expect((await run('git', ['config', '--local', '--get', 'core.hooksPath'], root)).stdout).toBe('.githooks\n');
    expect((await run('git', ['config', '--local', '--get', 'user.signingkey'], root)).stdout).toBe('fixture-key\n');
    expect((await run('git', ['config', '--global', '--get', 'core.hooksPath'], root, { env: isolatedEnv })).stdout).toBe('global-hooks\n');
    expect(await readFile(existingHook, 'utf8')).toBe('#!/bin/sh\nprintf unrelated\n');
  });

  it('discovers the repository root from a linked worktree subdirectory', async () => {
    const root = await createInstallFixture();
    const linked = join(root, '..', 'linked-worktree');
    temporaryDirectories.push(linked);
    const branchResult = await run('git', ['worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD'], root);
    expect(branchResult.exitCode).toBe(0);
    await mkdir(join(linked, 'nested'), { recursive: true });
    const linkedHook = join(linked, '.githooks/pre-push');
    expect(await readFile(linkedHook, 'utf8')).toContain('../scripts/pre-push.mjs');

    const result = await installHooks(join(linked, 'nested'));
    expect(result.repoRoot).toBe(linked);
    expect((await run('git', ['config', '--local', '--get', 'core.hooksPath'], linked)).stdout).toBe('.githooks\n');
  });
});
