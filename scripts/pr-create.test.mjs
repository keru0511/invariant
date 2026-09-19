import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PrCreateError,
  REPOSITORY,
  runPrCreate,
  parsePrCreateArgs,
} from './pr-create.mjs';

const HEAD_SHA = 'a'.repeat(40);
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function fixture(body = '# Change\n') {
  const root = mkdtempSync(join(tmpdir(), 'invariant-pr-create-test-'));
  temporaryDirectories.push(root);
  const bodyFile = join(root, 'body.md');
  writeFileSync(bodyFile, body, 'utf8');
  return { root, bodyFile };
}

function fakeRunner({
  branch = 'codex/issue-21-pr-create',
  remoteSha = HEAD_SHA,
  postCreateRemoteSha = remoteSha,
  gateExitCode = 0,
  readBack = null,
  createOutput = 'https://github.com/keru0511/Invariant/pull/321\n',
} = {}) {
  const calls = [];
  let createdBody;
  let createdDraft = false;
  let remoteLookups = 0;
  const run = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { status: 0, stdout: options.cwd + '\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'status') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'symbolic-ref') {
      return { status: 0, stdout: branch + '\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
      return { status: 0, stdout: HEAD_SHA + '\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'ls-remote') {
      remoteLookups += 1;
      const observedRemoteSha = remoteLookups >= 3 ? postCreateRemoteSha : remoteSha;
      return {
        status: observedRemoteSha === null ? 0 : 0,
        stdout: observedRemoteSha === null ? '' : `${observedRemoteSha}\trefs/heads/${branch}\n`,
        stderr: '',
      };
    }

    if ((command === 'npm' || command === 'npm.cmd') && args.join(' ') === 'run ci:local') {
      return { status: gateExitCode, stdout: '', stderr: gateExitCode ? 'gate failed\n' : '' };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      const bodyIndex = args.indexOf('--body-file');
      createdBody = readFileSync(args[bodyIndex + 1], 'utf8');
      createdDraft = args.includes('--draft');
      return { status: 0, stdout: createOutput, stderr: '' };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      const value = typeof readBack === 'function'
        ? readBack({ createdBody, createdDraft, args })
        : {
          title: readBack?.title ?? 'Add gated PR creation',
          body: readBack?.body ?? createdBody,
          baseRefName: readBack?.baseRefName ?? 'main',
          headRefName: readBack?.headRefName ?? branch,
          headRefOid: readBack?.headRefOid ?? HEAD_SHA,
          isDraft: readBack?.isDraft ?? createdDraft,
          state: readBack?.state ?? 'OPEN',
          url: readBack?.url ?? createOutput.trim(),
        };
      return { status: 0, stdout: JSON.stringify(value), stderr: '' };
    }
    throw new Error(`unexpected fake command: ${command} ${args.join(' ')}`);
  };
  return { calls, run, getCreatedBody: () => createdBody, getRemoteLookups: () => remoteLookups };
}

function expectCode(callback, code) {
  let error;
  try {
    callback();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PrCreateError);
  expect(error.code).toBe(code);
}

describe('pr:create argument parser', () => {
  it('accepts only title, body-file, and draft', () => {
    expect(parsePrCreateArgs(['--title', 'Fix it', '--body-file', 'body.md', '--draft']))
      .toEqual({ title: 'Fix it', bodyFile: 'body.md', draft: true });
  });

  it.each([
    ['--repo', 'target-changing repo flag'],
    ['--base', 'target-changing base flag'],
    ['--head', 'target-changing head flag'],
    ['--push', 'auto-push flag'],
    ['--unknown', 'unknown flag'],
  ])('rejects %s', (flag) => {
    expectCode(() => parsePrCreateArgs(['--title', 'Title', '--body-file', 'body.md', flag]), 'unknown-flag');
  });

  it('rejects missing required values and duplicate options', () => {
    expectCode(() => parsePrCreateArgs(['--title', '--body-file', 'body.md']), 'missing-value');
    expectCode(() => parsePrCreateArgs(['--title', 'Title']), 'missing-body-file');
    expectCode(() => parsePrCreateArgs(['--title', 'Title', '--title', 'Again', '--body-file', 'body.md']), 'duplicate-flag');
  });
});

describe('gated PR creation', () => {
  it('runs the gate once, creates exactly one PR, and verifies the read-back', () => {
    const { root, bodyFile } = fixture();
    const fake = fakeRunner();
    const result = runPrCreate({
      cwd: root,
      argv: ['--title', 'Add gated PR creation', '--body-file', bodyFile, '--draft'],
      run: fake.run,
    });

    const ghCreates = fake.calls.filter(({ command, args }) => command === 'gh' && args[1] === 'create');
    const ghViews = fake.calls.filter(({ command, args }) => command === 'gh' && args[1] === 'view');
    const npmCalls = fake.calls.filter(({ command, args }) => (command === 'npm' || command === 'npm.cmd') && args.join(' ') === 'run ci:local');
    expect(result).toMatchObject({ prUrl: 'https://github.com/keru0511/Invariant/pull/321', headSha: HEAD_SHA, draft: true });
    expect(ghCreates).toHaveLength(1);
    expect(ghViews).toHaveLength(1);
    expect(npmCalls).toHaveLength(1);
    expect(fake.calls.findIndex(({ command }) => command === 'npm')).toBeLessThan(fake.calls.findIndex(({ command }) => command === 'gh'));

    const createArgs = ghCreates[0].args;
    expect(createArgs).toContain('--repo');
    expect(createArgs).toContain(REPOSITORY);
    expect(createArgs).toContain('--base');
    expect(createArgs).toContain('main');
    expect(createArgs).toContain('--head');
    expect(createArgs).toContain('codex/issue-21-pr-create');
    expect(createArgs).toContain('--draft');
    expect(fake.getCreatedBody()).toContain(`Verified commit: \`${HEAD_SHA}\``);
    expect(fake.getCreatedBody()).toContain('npm","run","ci:local');
    expect(fake.calls.some(({ command, args }) => command === 'git' && args[0] === 'push')).toBe(false);
  });

  it('keeps shell metacharacters literal in parsed argv', () => {
    const { root, bodyFile } = fixture();
    const fake = fakeRunner({
      readBack: ({ createdBody, createdDraft }) => ({
        title: 'literal; $(touch pwned) && --base evil',
        body: createdBody,
        baseRefName: 'main',
        headRefName: 'codex/issue-21-pr-create',
        headRefOid: HEAD_SHA,
        isDraft: createdDraft,
        state: 'OPEN',
        url: 'https://github.com/keru0511/Invariant/pull/321',
      }),
    });
    const title = 'literal; $(touch pwned) && --base evil';
    const result = runPrCreate({ cwd: root, argv: ['--title', title, '--body-file', bodyFile], run: fake.run });
    expect(result.prUrl).toContain('/pull/321');
    const create = fake.calls.find(({ command, args }) => command === 'gh' && args[1] === 'create');
    expect(create.args[create.args.indexOf('--title') + 1]).toBe(title);
  });

  it.each([
    ['dirty worktree', { dirty: true }, 'dirty-worktree'],
    ['missing remote branch', { remoteSha: null }, 'remote-branch-missing'],
    ['stale remote branch', { remoteSha: 'b'.repeat(40) }, 'stale-remote-branch'],
    ['failing local gate', { gateExitCode: 17 }, 'gate-failed'],
  ])('creates no PR for %s', (_name, options, code) => {
    const { root, bodyFile } = fixture();
    const fake = fakeRunner(options);
    if (options.dirty) {
      const original = fake.run;
      fake.run = (command, args, runnerOptions) => {
        const result = original(command, args, runnerOptions);
        if (command === 'git' && args[0] === 'status') return { ...result, stdout: ' M tracked.txt\n' };
        return result;
      };
    }
    expectCode(() => runPrCreate({ cwd: root, argv: ['--title', 'Title', '--body-file', bodyFile], run: fake.run }), code);
    expect(fake.calls.some(({ command, args }) => command === 'gh' && args[1] === 'create')).toBe(false);
  });

  it('reports a read-back mismatch as failure after the single create call', () => {
    const { root, bodyFile } = fixture();
    const fake = fakeRunner({
      readBack: {
        title: 'wrong title',
        body: 'wrong body',
        baseRefName: 'develop',
        headRefName: 'other',
        isDraft: false,
        state: 'OPEN',
        url: 'https://github.com/keru0511/Invariant/pull/321',
      },
    });
    let error;
    try {
      runPrCreate({ cwd: root, argv: ['--title', 'Title', '--body-file', bodyFile], run: fake.run });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'readback-mismatch' });
    expect(fake.calls.filter(({ command, args }) => command === 'gh' && args[1] === 'create')).toHaveLength(1);
  });
  it('rejects a remote branch that advances after PR creation', () => {
    const { root, bodyFile } = fixture();
    const advancedSha = 'b'.repeat(40);
    const fake = fakeRunner({ postCreateRemoteSha: advancedSha });
    let error;
    try {
      runPrCreate({ cwd: root, argv: ['--title', 'Title', '--body-file', bodyFile], run: fake.run });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'post-create-remote-mismatch' });
    expect(error.message).toContain('https://github.com/keru0511/Invariant/pull/321');
    expect(error.message).toContain(advancedSha);
    expect(fake.getRemoteLookups()).toBe(3);
    expect(fake.calls.filter(({ command, args }) => command === 'gh' && args[1] === 'create')).toHaveLength(1);
  });

  it('rejects a PR read-back whose head OID differs from the verified head', () => {
    const { root, bodyFile } = fixture();
    const mismatchedSha = 'c'.repeat(40);
    const fake = fakeRunner({
      readBack: ({ createdBody, createdDraft }) => ({
        title: 'Title',
        body: createdBody,
        baseRefName: 'main',
        headRefName: 'codex/issue-21-pr-create',
        headRefOid: mismatchedSha,
        isDraft: createdDraft,
        state: 'OPEN',
        url: 'https://github.com/keru0511/Invariant/pull/321',
      }),
    });
    let error;
    try {
      runPrCreate({ cwd: root, argv: ['--title', 'Title', '--body-file', bodyFile], run: fake.run });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'readback-head-mismatch' });
    expect(error.message).toContain('https://github.com/keru0511/Invariant/pull/321');
    expect(error.message).toContain(mismatchedSha);
  });

});
