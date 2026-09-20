import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { installHooks } from './hooks-install.mjs';
import {
  PrePushError,
  parsePrePushInput,
  runPrePushHook,
} from './pre-push.mjs';

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories = [];
const ZERO_SHA = '0'.repeat(40);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function expectUnsupported(input, message) {
  let error;
  try {
    parsePrePushInput(input, { currentBranch: 'feature/one' });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PrePushError);
  expect(error.code).toBe('unsupported-push');
  expect(error.message).toContain(message);
}

describe('pre-push refspec parser', () => {
  it('accepts one current branch update, including the initial zero remote SHA', () => {
    const input = 'refs/heads/feature/one ' + SHA_A
      + ' refs/heads/feature/one ' + ZERO_SHA + '\n';
    expect(parsePrePushInput(input, { currentBranch: 'feature/one' })).toMatchObject({
      branch: 'feature/one',
      isCreate: true,
      localSha: SHA_A,
      remoteSha: ZERO_SHA,
    });
  });

  it('accepts a later same-branch update', () => {
    const input = 'refs/heads/feature/one ' + SHA_B
      + ' refs/heads/feature/one ' + SHA_A;
    expect(parsePrePushInput(input, { currentBranch: 'feature/one' }).isCreate).toBe(false);
  });

  it('accepts HEAD as the current branch source ref', () => {
    const input = 'HEAD ' + SHA_A + ' refs/heads/feature/one ' + ZERO_SHA;
    expect(parsePrePushInput(input, { currentBranch: 'feature/one' }).localRef)
      .toBe('refs/heads/feature/one');
  });

  it.each([
    ['refs/tags/v1.0.0 ' + SHA_A + ' refs/tags/v1.0.0 ' + ZERO_SHA, 'only refs/heads'],
    ['refs/heads/feature/one ' + ZERO_SHA + ' refs/heads/feature/one ' + SHA_A, 'branch deletion'],
    [
      'refs/heads/feature/one ' + SHA_A + ' refs/heads/other ' + ZERO_SHA,
      'same remote ref',
    ],
    [
      'refs/heads/other ' + SHA_A + ' refs/heads/other ' + ZERO_SHA,
      'current branch',
    ],
    [
      'refs/heads/feature/one ' + SHA_A + ' refs/heads/feature/one ' + ZERO_SHA + '\n'
        + 'refs/heads/feature/one ' + SHA_B + ' refs/heads/feature/one ' + SHA_A,
      'exactly one',
    ],
    ['not a refspec', 'four refspec fields'],
  ])('rejects unsupported input: %s', (input, message) => {
    expectUnsupported(input, message);
  });
});

async function run(command, args, cwd, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolvePromise({ exitCode: null, stdout, stderr, error }));
    child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal, stdout, stderr, error: null }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function createHookFixture(prefix = 'invariant-pre-push-') {
  const root = await temporaryDirectory(prefix);
  await mkdir(join(root, '.githooks'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'nested'), { recursive: true });
  await copyFile(join(sourceRoot, '.githooks/pre-push'), join(root, '.githooks/pre-push'));
  await copyFile(join(sourceRoot, 'scripts/pre-push.mjs'), join(root, 'scripts/pre-push.mjs'));
  await copyFile(join(sourceRoot, 'scripts/hooks-install.mjs'), join(root, 'scripts/hooks-install.mjs'));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'pre-push-fixture',
    private: true,
    type: 'module',
    scripts: {
      'hooks:install': 'node scripts/hooks-install.mjs',
      'ci:local': 'node fake-gate.mjs',
    },
  }) + '\n');
  await writeFile(join(root, 'fake-gate.mjs'), 'process.exit(Number(process.env.FAKE_GATE_EXIT ?? 0));\n');
  await chmod(join(root, '.githooks/pre-push'), 0o755);
  await run('git', ['init', '-q', '-b', 'feature/one'], root);
  await run('git', ['config', 'user.email', 'hook-test@example.invalid'], root);
  await run('git', ['config', 'user.name', 'hook-test'], root);
  await writeFile(join(root, 'tracked.txt'), 'initial\n');
  await run('git', ['add', '.'], root);
  await run('git', ['commit', '-qm', 'fixture'], root);
  return root;
}

function currentBranchInput({ localSha = SHA_A, remoteSha = ZERO_SHA } = {}) {
  return 'refs/heads/feature/one ' + localSha
    + ' refs/heads/feature/one ' + remoteSha + '\n';
}

async function currentHead(root) {
  const result = await run('git', ['rev-parse', 'HEAD'], root);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

describe('pre-push gate execution', () => {
  it('calls npm run ci:local once and propagates its failure status', async () => {
    const root = await createHookFixture();
    const calls = [];
    const fakeSpawn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 23, signal: null, error: null };
    };

    const status = runPrePushHook({
      cwd: join(root, 'nested'),
      input: currentBranchInput({ localSha: await currentHead(root) }),
      spawn: fakeSpawn,
    });

    expect(status).toBe(23);
    expect(calls).toEqual([{
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', 'ci:local'],
      cwd: root,
    }]);
  });

  it('rejects a pushed SHA that does not match the current HEAD before running CI', async () => {
    const root = await createHookFixture();
    const calls = [];
    expect(() => runPrePushHook({
      cwd: root,
      input: currentBranchInput({ localSha: SHA_A }),
      spawn: (...args) => {
        calls.push(args);
        return { status: 0, signal: null, error: null };
      },
    })).toThrow(/does not match the pushed local SHA/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a HEAD change made while local CI is running', async () => {
    const root = await createHookFixture();
    const pushedSha = await currentHead(root);
    const fakeSpawn = (command, args, options) => {
      const result = spawnSync('git', ['commit', '--allow-empty', '-qm', 'race'], {
        cwd: options.cwd,
        stdio: 'ignore',
      });
      expect(result).toBeDefined();
      return { status: 0, signal: null, error: null };
    };
    expect(() => runPrePushHook({
      cwd: root,
      input: currentBranchInput({ localSha: pushedSha }),
      spawn: fakeSpawn,
    })).toThrow(/HEAD changed during local CI/);
  });

  it('does not invoke npm for unsupported input', async () => {
    const root = await createHookFixture();
    const calls = [];
    expect(() => runPrePushHook({
      cwd: root,
      input: 'refs/tags/v1 ' + SHA_A + ' refs/tags/v1 ' + ZERO_SHA + '\n',
      spawn: (...args) => {
        calls.push(args);
        return { status: 0, signal: null, error: null };
      },
    })).toThrow(/only refs\/heads/);
    expect(calls).toHaveLength(0);
  });
});

async function createBareRemote(root) {
  const remote = join(root, 'remote.git');
  const result = await run('git', ['init', '--bare', '-q', remote], root);
  expect(result.exitCode).toBe(0);
  await run('git', ['remote', 'add', 'origin', remote], root);
  return remote;
}

async function createFakeNpm(root) {
  const bin = join(root, 'fake-bin');
  await mkdir(bin, { recursive: true });
  const calls = join(root, 'npm-calls.log');
  const fakeNpm = join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (process.platform === 'win32') {
    await writeFile(fakeNpm, '@echo off\necho %*>>"%HOOK_CALLS%"\nexit /b %FAKE_GATE_EXIT%\n');
  } else {
    await writeFile(fakeNpm, '#!/usr/bin/env node\n'
      + 'import { appendFileSync } from "node:fs";\n'
      + 'appendFileSync(process.env.HOOK_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\n'
      + 'process.exit(Number(process.env.FAKE_GATE_EXIT || "0"));\n');
  }
  await chmod(fakeNpm, 0o755);
  return {
    calls,
    env: {
      ...process.env,
      PATH: bin + (process.env.PATH ? ':' + process.env.PATH : ''),
      HOOK_CALLS: calls,
      FAKE_GATE_EXIT: '0',
    },
  };
}

async function readRemoteSha(remote) {
  const result = await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/feature/one'], remote);
  return result.stdout.trim();
}

describe('real push integration', () => {
  it('runs on first and later pushes to the same branch', async () => {
    const root = await createHookFixture('invariant-pre-push-push-');
    const remote = await createBareRemote(root);
    await installHooks(root);
    const fakeNpm = await createFakeNpm(root);

    const first = await run(
      'git',
      ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/feature/one'],
      root,
      { env: fakeNpm.env },
    );
    expect(first.exitCode).toBe(0);

    await writeFile(join(root, 'tracked.txt'), 'later\n');
    await run('git', ['add', 'tracked.txt'], root);
    await run('git', ['commit', '-qm', 'later'], root);
    const second = await run('git', ['push', 'origin'], root, { env: fakeNpm.env });
    expect(second.exitCode).toBe(0);

    const calls = (await readFile(fakeNpm.calls, 'utf8')).trim().split('\n').filter(Boolean);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0])).toEqual(['run', 'ci:local']);
    expect(JSON.parse(calls[1])).toEqual(['run', 'ci:local']);
    expect(await readRemoteSha(remote)).toBe((await run('git', ['rev-parse', 'HEAD'], root)).stdout.trim());
  });

  it('leaves the bare remote SHA unchanged when the gate fails', async () => {
    const root = await createHookFixture('invariant-pre-push-failure-');
    const remote = await createBareRemote(root);
    await installHooks(root);
    const fakeNpm = await createFakeNpm(root);
    const first = await run(
      'git',
      ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/feature/one'],
      root,
      { env: fakeNpm.env },
    );
    expect(first.exitCode).toBe(0);
    const remoteBefore = await readRemoteSha(remote);

    await writeFile(join(root, 'tracked.txt'), 'blocked\n');
    await run('git', ['add', 'tracked.txt'], root);
    await run('git', ['commit', '-qm', 'blocked'], root);
    const failingEnv = { ...fakeNpm.env, FAKE_GATE_EXIT: '23' };
    const failed = await run('git', ['push', 'origin'], root, { env: failingEnv });
    expect(failed.exitCode).not.toBe(0);
    expect(await readRemoteSha(remote)).toBe(remoteBefore);

    const calls = (await readFile(fakeNpm.calls, 'utf8')).trim().split('\n').filter(Boolean);
    expect(calls).toHaveLength(2);
  });
});
