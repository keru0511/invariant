import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const ACTRUN_VERSION = '0.32.0';
const WORKFLOW = `name: CI

on:
  workflow_dispatch:
  push:
    branches-ignore:
      - '**'

jobs:
  quality:
    name: quality
    runs-on: ubuntu-latest
    steps:
      - id: install
        run: npm ci
      - id: typecheck
        run: npm run typecheck
      - id: tests
        run: npm test
`;

const TYPESCRIPT = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
`;

function run(command, args, cwd, timeoutMs = 120_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout, stderr, error, timedOut });
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, signal, stdout, stderr, error: null, timedOut });
    });
  });
}

async function writeFixture(root, name, kind) {
  const fixture = join(root, name);
  await mkdir(join(fixture, '.github', 'workflows'), { recursive: true });
  await mkdir(join(fixture, 'src'), { recursive: true });
  await mkdir(join(fixture, 'test'), { recursive: true });
  await writeFile(join(fixture, '.github', 'workflows', 'ci.yml'), WORKFLOW);
  await writeFile(join(fixture, 'tsconfig.json'), TYPESCRIPT);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: `ci-gate-fixture-${name}`,
    private: true,
    version: '1.0.0',
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'node --test',
    },
    devDependencies: { typescript: '5.7.2' },
  }, null, 2) + '\n');

  if (kind === 'type-error') {
    await writeFile(join(fixture, 'src', 'broken.ts'), 'const count: number = "not a number";\nexport { count };\n');
  } else {
    await writeFile(join(fixture, 'src', 'valid.ts'), 'export const count: number = 1;\n');
  }
  const testSource = kind === 'test-failure'
    ? "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('real failing test', () => assert.equal(1, 2));\n"
    : "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('real passing test', () => assert.equal(1, 1));\n";
  await writeFile(join(fixture, 'test', 'smoke.test.mjs'), testSource);

  const lock = await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], fixture);
  if (lock.exitCode !== 0) {
    throw new Error(`fixture lockfile generation failed for ${name}: ${lock.stderr || lock.stdout}`);
  }
  for (const args of [['init', '-q'], ['config', 'user.email', 'ci-gate@example.invalid'], ['config', 'user.name', 'ci-gate-smoke']]) {
    const result = await run('git', args, fixture);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  const add = await run('git', ['add', '.'], fixture);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
  const commit = await run('git', ['commit', '-m', `fixture: ${kind}`], fixture);
  if (commit.exitCode !== 0) throw new Error(`fixture commit failed: ${commit.stderr || commit.stdout}`);
  const sha = await run('git', ['rev-parse', 'HEAD'], fixture);
  if (sha.exitCode !== 0) throw new Error(`fixture SHA lookup failed: ${sha.stderr || sha.stdout}`);
  return { fixture, sha: sha.stdout.trim() };
}

async function readSingleRecord(runRoot) {
  const entries = await readdir(runRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) {
    throw new Error(`expected one run directory, found ${directories.length}`);
  }
  const path = join(runRoot, directories[0].name, 'run.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  return { path, runId: directories[0].name, record };
}

function mandatoryStepStatus(record, stepId) {
  return record.steps?.find((step) => step.id === `quality/${stepId}`)?.status;
}

async function smokeFixture({ fixture, sha, root, name, expectedFailureStep = null }) {
  const runRoot = join(root, `${name}-runs`);
  const runner = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'actrun.cmd' : 'actrun');
  const args = [
    'workflow', 'run', '.github/workflows/ci.yml',
    '--trigger', 'push',
    '--repo', fixture,
    '--workspace-mode', 'worktree',
    '--run-root', runRoot,
  ];
  const result = await run(runner, args, fixture);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/only push and workflow_call triggers are supported in MVP/.test(combined)) {
    return {
      name,
      command: `${runner} ${args.join(' ')}`,
      exitCode: result.exitCode,
      blocked: true,
      expectedFailureStep,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  const run = await readSingleRecord(runRoot);
  const actualFailureStep = expectedFailureStep
    ? ['install', 'typecheck', 'tests'].find((stepId) => mandatoryStepStatus(run.record, stepId) === 'failed') ?? null
    : null;
  const success = expectedFailureStep === null
    ? result.exitCode === 0
      && run.record.event === 'push'
      && run.record.headSha === sha
      && run.record.state === 'completed'
      && run.record.conclusion === 'success'
      && run.record.ok === true
      && ['install', 'typecheck', 'tests'].every((stepId) => mandatoryStepStatus(run.record, stepId) === 'success')
    : result.exitCode !== 0
      && run.record.event === 'push'
      && run.record.headSha === sha
      && run.record.conclusion === 'failure'
      && actualFailureStep === expectedFailureStep;
  if (!success) {
    throw new Error(`fixture ${name} did not meet expected result: ${JSON.stringify({ result, run }, null, 2)}`);
  }
  return {
    name,
    command: `${runner} ${args.join(' ')}`,
    testedSha: sha,
    runId: run.runId,
    runRecord: run.path,
    exitCode: result.exitCode,
    blocked: false,
    expectedFailureStep,
    actualFailureStep,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

const root = await mkdtemp(join(tmpdir(), 'invariant-ci-gate-smoke-'));
try {
  const fixtures = [
    { name: 'positive', kind: 'positive', expectedFailureStep: null },
    { name: 'type-error', kind: 'type-error', expectedFailureStep: 'typecheck' },
    { name: 'test-failure', kind: 'test-failure', expectedFailureStep: 'tests' },
  ];
  const results = [];
  for (const fixtureSpec of fixtures) {
    const fixture = await writeFixture(root, fixtureSpec.name, fixtureSpec.kind);
    results.push(await smokeFixture({ ...fixtureSpec, ...fixture, root }));
  }
  process.stdout.write(`${JSON.stringify({ actrun: ACTRUN_VERSION, results }, null, 2)}\n`);
  if (results.some((result) => result.blocked)) {
    process.stderr.write('test:ci-gate: BLOCKED; the installed actrun did not execute the forced push workflow.\n');
    process.exitCode = 2;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
