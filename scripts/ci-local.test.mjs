import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execPath } from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_IGNORED_PREFIXES,
  EXPECTED_ACTRUN_VERSION,
  GateError,
  assertCleanStatus,
  assertCallerHeadUnchanged,
  assertUniqueCurrentRun,
  assertExactToolchain,
  createSnapshot,
  findRunRecords,
  main,
  runActrunProcess,
  runCommand,
  runGit,
  removeSnapshot,
  validateWorkflowDefinition,
  verifyRunRecord,
  verifySnapshotHead,
} from './ci-local.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function expectGateError(callback, code) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GateError);
  expect(caught.code).toBe(code);
}

function expectAsyncGateError(callback, code) {
  return expect(callback()).rejects.toMatchObject({ code });
}

function validRunRecord() {
  const mandatoryStepIds = ['install', 'typecheck', 'tests'];
  return {
    run_id: 'run-1',
    workflowName: 'CI',
    event: 'push',
    workspace_mode: 'worktree',
    headSha: 'a'.repeat(40),
    status: 'completed',
    state: 'completed',
    conclusion: 'success',
    ok: true,
    exit_code: 0,
    steps: mandatoryStepIds.map((id) => ({ id: `quality/${id}`, status: 'success' })),
    tasks: mandatoryStepIds.map((id) => ({ id: `quality/${id}`, status: 'success', code: 0 })),
    jobs: [{
      id: 'quality',
      name: 'quality',
      status: 'completed',
      conclusion: 'success',
      steps: mandatoryStepIds.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    }],
  };
}

describe('workflow contract', () => {
  it('accepts the committed dual-trigger workflow', async () => {
    const source = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(validateWorkflowDefinition(source)).toBe(true);
  });

  it('rejects workflow_dispatch-only and unfiltered push workflows', async () => {
    const source = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expectGateError(() => validateWorkflowDefinition(source.replace("  push:\n    branches-ignore:\n      - '**'\n", '')), 'workflow-contract');
    expectGateError(
      () => validateWorkflowDefinition(source.replace("      - '**'", "      - main")),
      'workflow-contract',
    );
  });
});

describe('caller cleanliness and immutable snapshot guards', () => {
  it.each(['M  tracked.ts', ' M tracked.ts', '?? new-file.ts'])('rejects caller status %s', (status) => {
    expectGateError(() => assertCleanStatus({ porcelain: status }), 'caller-dirty');
  });

  it('rejects undeclared ignored paths but accepts declared artifacts', () => {
    expectGateError(() => assertCleanStatus({ ignored: '!! secret.env' }), 'undeclared-ignored-path');
    expect(() => assertCleanStatus({
      ignored: ALLOWED_IGNORED_PREFIXES.map((prefix) => `!! ${prefix}fixture`).join('\n'),
    })).not.toThrow();
  });

  it('rejects a snapshot SHA mismatch', () => {
    expectGateError(() => verifySnapshotHead('a'.repeat(40), 'b'.repeat(40)), 'snapshot-drift');
    expect(() => verifySnapshotHead('a'.repeat(40), 'a'.repeat(40))).not.toThrow();
  });

  it('rejects caller HEAD drift after the runner returns', () => {
    expectGateError(() => assertCallerHeadUnchanged('a'.repeat(40), 'b'.repeat(40)), 'caller-changed');
    expect(() => assertCallerHeadUnchanged('a'.repeat(40), 'a'.repeat(40))).not.toThrow();
  });

  it('creates and removes a detached snapshot worktree', async () => {
    const root = await temporaryDirectory('invariant-snapshot-test-');
    await runGit(['init', '-q'], root);
    await runGit(['config', 'user.email', 'ci-test@example.invalid'], root);
    await runGit(['config', 'user.name', 'ci-test'], root);
    await writeFile(join(root, 'tracked.txt'), 'snapshot\n');
    await runGit(['add', 'tracked.txt'], root);
    await runGit(['commit', '-m', 'fixture'], root);
    const sha = await runGit(['rev-parse', 'HEAD'], root);
    let snapshotInfo;
    try {
      snapshotInfo = await createSnapshot(root, sha);
      const during = await runGit(['worktree', 'list', '--porcelain'], root);
      expect(during).toContain(`worktree ${snapshotInfo.snapshot}`);
    } finally {
      await removeSnapshot(root, snapshotInfo);
    }
    const after = await runGit(['worktree', 'list', '--porcelain'], root);
    expect(after).not.toContain('invariant-ci-local-');
  });
});

describe('fail-closed run-record validation', () => {
  it('accepts exactly one successful push run with all mandatory records', () => {
    const record = validRunRecord();
    expect(verifyRunRecord(record, {
      capturedHeadSha: record.headSha,
      runnerExitCode: 0,
      runDirectoryName: record.run_id,
    })).toMatchObject({ runId: 'run-1', workflow: 'CI', job: 'quality' });
  });

  it('rejects records for another SHA or a nonzero runner exit', () => {
    const record = validRunRecord();
    expectGateError(() => verifyRunRecord(record, {
      capturedHeadSha: 'b'.repeat(40),
      runnerExitCode: 0,
      runDirectoryName: record.run_id,
    }), 'run-record-mismatch');
    expectGateError(() => verifyRunRecord(record, {
      capturedHeadSha: record.headSha,
      runnerExitCode: 1,
      runDirectoryName: record.run_id,
    }), 'runner-failed');
  });

  it('rejects duplicate, skipped, or missing mandatory steps', () => {
    const duplicate = validRunRecord();
    duplicate.steps.push({ id: 'quality/install', status: 'success' });
    expectGateError(() => verifyRunRecord(duplicate, {
      capturedHeadSha: duplicate.headSha,
      runnerExitCode: 0,
      runDirectoryName: duplicate.run_id,
    }), 'run-record-malformed');

    const skipped = validRunRecord();
    skipped.steps[1].status = 'skipped';
    expectGateError(() => verifyRunRecord(skipped, {
      capturedHeadSha: skipped.headSha,
      runnerExitCode: 0,
      runDirectoryName: skipped.run_id,
    }), 'mandatory-step-failed');

    const missing = validRunRecord();
    missing.jobs[0].steps = missing.jobs[0].steps.filter(({ name }) => name !== 'tests');
    expectGateError(() => verifyRunRecord(missing, {
      capturedHeadSha: missing.headSha,
      runnerExitCode: 0,
      runDirectoryName: missing.run_id,
    }), 'mandatory-step-failed');
  });

  it('rejects missing and concurrent run records', () => {
    expectGateError(() => assertUniqueCurrentRun([]), 'run-record-missing');
    expectGateError(() => assertUniqueCurrentRun([{ run_id: 'run-1' }, { run_id: 'run-2' }]), 'run-record-not-unique');
  });

  it('rejects malformed or incomplete run directories', async () => {
    const root = await temporaryDirectory('invariant-run-record-test-');
    await mkdir(join(root, 'run-1'));
    await expectAsyncGateError(() => findRunRecords(root), 'run-record-malformed');

    const malformed = await temporaryDirectory('invariant-run-record-malformed-');
    await mkdir(join(malformed, 'run-1'));
    await writeFile(join(malformed, 'run-1', 'run.json'), '{not-json');
    await expectAsyncGateError(() => findRunRecords(malformed), 'run-record-malformed');
  });
});

describe('exact toolchain and entrypoint guards', () => {
  it('fails when the running Node version is not the exact pinned version', async () => {
    const root = await temporaryDirectory('invariant-toolchain-node-');
    const wrongVersion = process.versions.node === '22.19.0' ? '24.19.0' : '22.19.0';
    await writeFile(join(root, '.node-version'), `${wrongVersion}\n`);
    await expectAsyncGateError(() => assertExactToolchain(root, {
      expectedNodeVersion: wrongVersion,
      expectedNpmVersion: '11.9.0',
      expectedActrunVersion: EXPECTED_ACTRUN_VERSION,
    }), 'wrong-node-version');
  });

  it('rejects a missing caller-installed runner without fallback', async () => {
    const root = await temporaryDirectory('invariant-toolchain-runner-');
    await mkdir(join(root, 'node_modules/@mizchi/actrun'), { recursive: true });
    await writeFile(join(root, '.node-version'), `${process.versions.node}\n`);
    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@mizchi/actrun': EXPECTED_ACTRUN_VERSION } }));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({
      packages: {
        'node_modules/@mizchi/actrun': {
          version: EXPECTED_ACTRUN_VERSION,
          resolved: 'https://registry.npmjs.org/@mizchi/actrun/-/actrun-0.32.0.tgz',
          integrity: 'sha512-test',
        },
      },
    }));
    await writeFile(join(root, 'node_modules/@mizchi/actrun/package.json'), JSON.stringify({ version: EXPECTED_ACTRUN_VERSION }));
    await expectAsyncGateError(() => assertExactToolchain(root, {
      expectedNodeVersion: process.versions.node,
      expectedNpmVersion: '11.9.0',
      expectedActrunVersion: EXPECTED_ACTRUN_VERSION,
      npmVersionOverride: '11.9.0',
    }), 'missing-runner');
  });

  it('fails closed when a dependency command exits nonzero', async () => {
    await expectAsyncGateError(
      () => runCommand(execPath, ['-e', "process.stderr.write('dependency install failed'); process.exit(7)"], { cwd: repoRoot }),
      'command-failed',
    );
  });

  it('rejects runner arguments at the public entrypoint', async () => {
    await expectAsyncGateError(() => main(['--trigger', 'push']), 'usage');
  });

  it('keeps normal tests separate from the real actrun smoke', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const smoke = await readFile(join(repoRoot, 'scripts/ci-gate-smoke.mjs'), 'utf8');
    expect(packageJson.scripts.test).toBe('vitest run');
    expect(packageJson.scripts['test:ci-gate']).toBe('node scripts/ci-gate-smoke.mjs');
    expect(smoke).toContain("'--trigger', 'push'");
    expect(smoke).not.toContain('ci:local');
    expect(smoke).toContain("expectedFailureStep: 'typecheck'");
    expect(smoke).toContain("expectedFailureStep: 'tests'");
  });
});

describe('bounded runner cleanup', () => {
  it('terminates a long-running child on timeout', async () => {
    const result = await runActrunProcess(execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: repoRoot,
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });
});
