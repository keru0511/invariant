import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const EXPECTED_NODE_VERSION = '24.19.0';
export const EXPECTED_NPM_VERSION = '11.9.0';
export const EXPECTED_ACTRUN_VERSION = '0.32.0';
export const WORKFLOW_PATH = '.github/workflows/ci.yml';
export const WORKFLOW_NAME = 'CI';
export const JOB_ID = 'quality';
export const MANDATORY_STEP_IDS = ['install', 'typecheck', 'tests'];
export const LOCAL_TRIGGER = 'push';
export const ALLOWED_IGNORED_PREFIXES = [
  'node_modules/',
  '.actrun-runs/',
  '_build/',
];

export const ACTION_REVISIONS = Object.freeze({
  'actions/checkout': '11bd71901bbe5b1630ceea73d27597364c9af683',
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
});

export class GateError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'GateError';
    this.code = code;
  }
}

function commandFailure(command, args, error) {
  const detail = error?.stderr?.trim() || error?.stdout?.trim() || error?.message || 'unknown error';
  return new GateError(
    'command-failed',
    `${command} ${args.join(' ')} failed: ${detail}`,
    error,
  );
}

export async function runCommand(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    });
  } catch (error) {
    throw commandFailure(command, args, error);
  }
}

export async function runGit(args, cwd) {
  const result = await runCommand('git', args, { cwd });
  return result.stdout.trimEnd();
}

export function parsePorcelainLines(output) {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3),
      raw: line,
    }));
}

function allowedIgnoredPath(path) {
  return ALLOWED_IGNORED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

export function assertCleanStatus({ porcelain = '', ignored = '' } = {}) {
  const changed = parsePorcelainLines(porcelain);
  if (changed.length > 0) {
    const details = changed.map(({ raw }) => raw).join(', ');
    throw new GateError(
      'caller-dirty',
      `caller worktree is not clean; refusing to run (staged, unstaged, or non-ignored changes: ${details})`,
    );
  }

  const illegalIgnored = parsePorcelainLines(ignored)
    .filter(({ status }) => status === '!!')
    .filter(({ path }) => !allowedIgnoredPath(path));
  if (illegalIgnored.length > 0) {
    const details = illegalIgnored.map(({ path }) => path).join(', ');
    throw new GateError(
      'undeclared-ignored-path',
      `caller contains ignored paths outside the declared dependency/run-artifact paths: ${details}`,
    );
  }
}

export async function readCallerStatus(repoRoot) {
  const [porcelain, ignored] = await Promise.all([
    runGit(['status', '--porcelain=v1', '--untracked-files=all'], repoRoot),
    runGit(['status', '--porcelain=v1', '--ignored', '--untracked-files=all'], repoRoot),
  ]);
  return { porcelain, ignored };
}

export async function assertCallerClean(repoRoot) {
  const status = await readCallerStatus(repoRoot);
  assertCleanStatus(status);
  return status;
}

function workflowContractError(message) {
  throw new GateError('workflow-contract', message);
}

export function validateWorkflowDefinition(source) {
  if (!/^name:\s*CI\s*$/m.test(source)) {
    workflowContractError('workflow name must be CI');
  }

  const triggerBlock = source.match(/^on:\s*\n([\s\S]*?)(?=^(?:permissions|concurrency|jobs):\s*$)/m)?.[1] ?? '';
  const normalizedTrigger = triggerBlock
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/^ {2}/gm, '');
  const expectedTrigger = [
    'workflow_dispatch:',
    'push:',
    '  branches-ignore:',
    "    - '**'",
    'pull_request:',
    '  branches:',
    '    - main',
  ].join('\n');
  if (normalizedTrigger !== expectedTrigger) {
    workflowContractError("workflow triggers must retain workflow_dispatch plus inert push branches-ignore ['**'] and add pull_request branches [main]");
  }

  const permissionsBlock = source.match(/^permissions:\s*\n([\s\S]*?)(?=^(?:concurrency|jobs):\s*$)/m)?.[1] ?? '';
  const normalizedPermissions = permissionsBlock
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/^ {2}/gm, '');
  if (normalizedPermissions !== 'contents: read') {
    workflowContractError('workflow permissions must be read-only contents: read');
  }

  const concurrencyBlock = source.match(/^concurrency:\s*\n([\s\S]*?)(?=^jobs:\s*$)/m)?.[1] ?? '';
  const normalizedConcurrency = concurrencyBlock
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/^ {2}/gm, '');
  const expectedConcurrency = [
    'group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    'cancel-in-progress: true',
  ].join('\n');
  if (normalizedConcurrency !== expectedConcurrency) {
    workflowContractError('workflow concurrency must group by workflow and pull request number/ref with cancellation enabled');
  }

  const workflowLines = source.replace(/\r\n/g, '\n').split('\n');
  const jobsIndex = workflowLines.findIndex((line) => line === 'jobs:');
  if (jobsIndex === -1) {
    workflowContractError('workflow must define jobs');
  }

  const jobHeaders = workflowLines
    .map((line, index) => ({ match: line.match(/^  ([A-Za-z0-9_-]+):\s*$/), index }))
    .filter(({ match, index }) => match && index > jobsIndex)
    .map(({ match, index }) => ({ id: match[1], index }));
  if (jobHeaders.length !== 1 || jobHeaders[0].id !== JOB_ID) {
    workflowContractError(`workflow must define exactly one approved job: ${JOB_ID}`);
  }

  const qualityJob = jobHeaders[0];
  const qualityJobEnd = jobHeaders[1]?.index ?? workflowLines.length;
  const qualityJobLines = workflowLines.slice(qualityJob.index, qualityJobEnd);
  if (!qualityJobLines.includes('    name: quality')) {
    workflowContractError('workflow job quality must have name quality');
  }
  if (!qualityJobLines.includes('    timeout-minutes: 10')) {
    workflowContractError('workflow job quality must have a 10 minute timeout');
  }
  if (qualityJobLines.filter((line) => line === '    steps:').length !== 1) {
    workflowContractError('workflow job quality must define exactly one steps block');
  }

  const stepStarts = workflowLines
    .map((line, index) => ({ match: line.match(/^      - id: ([A-Za-z0-9_-]+)\s*$/), index }))
    .filter(({ index, match }) => match && index > qualityJob.index && index < qualityJobEnd)
    .map(({ match, index }) => ({ id: match[1], index }));
  const topLevelStepItems = qualityJobLines.filter((line) => /^      - /.test(line));
  const expectedStepIds = ['checkout', 'setup-node', ...MANDATORY_STEP_IDS];
  if (
    topLevelStepItems.length !== expectedStepIds.length
    || stepStarts.length !== expectedStepIds.length
    || stepStarts.map(({ id }) => id).join(',') !== expectedStepIds.join(',')
  ) {
    workflowContractError(
      `workflow job quality must contain exactly these ordered steps: ${expectedStepIds.join(', ')}`,
    );
  }

  const actionEntries = [];
  for (const [stepIndex, step] of stepStarts.entries()) {
    const end = stepStarts[stepIndex + 1]?.index ?? qualityJobEnd;
    const stepLines = workflowLines.slice(step.index, end);
    const usesLines = stepLines.filter((line) => /^\s*uses\s*:/.test(line));
    const runLines = stepLines.filter((line) => /^\s*run\s*:/.test(line));
    const expectedAction = step.id === 'checkout'
      ? 'actions/checkout'
      : step.id === 'setup-node'
        ? 'actions/setup-node'
        : null;

    if (expectedAction) {
      if (usesLines.length !== 1) {
        workflowContractError(`${step.id} must contain exactly one uses entry`);
      }
      if (runLines.length > 0) {
        workflowContractError(`${step.id} may not contain a run entry`);
      }
      if (step.id === 'setup-node' && !stepLines.includes('          cache: npm')) {
        workflowContractError('setup-node must enable the npm dependency cache');
      }
    } else {
      if (usesLines.length > 0) {
        workflowContractError(`unapproved uses entry in step ${step.id}`);
      }
      const requiredCommand = {
        install: 'npm ci',
        typecheck: 'npm run typecheck',
        tests: 'npm test',
      }[step.id];
      if (runLines.length !== 1 || runLines[0] !== `        run: ${requiredCommand}`) {
        workflowContractError(`step ${step.id} must run ${requiredCommand}`);
      }
    }

    for (const usesLine of usesLines) {
      const value = usesLine.match(/^\s*uses\s*:\s*(\S+)\s*$/)?.[1];
      if (!value) {
        workflowContractError(`uses entry in step ${step.id} is malformed`);
      }
      const separator = value.lastIndexOf('@');
      const action = separator > 0 ? value.slice(0, separator) : value;
      const revision = separator > 0 ? value.slice(separator + 1) : '';
      if (!Object.hasOwn(ACTION_REVISIONS, action)) {
        workflowContractError(`uses entry ${value} is not approved`);
      }
      if (!/^[0-9a-f]{40}$/.test(revision) || revision !== ACTION_REVISIONS[action]) {
        workflowContractError(
          `${action} must use exact approved revision ${ACTION_REVISIONS[action]}`,
        );
      }
      if (action !== expectedAction) {
        workflowContractError(`${step.id} must use ${expectedAction}`);
      }
      actionEntries.push(action);
    }
  }

  for (const action of Object.keys(ACTION_REVISIONS)) {
    const count = actionEntries.filter((entry) => entry === action).length;
    if (count !== 1) {
      workflowContractError(`${action} must appear exactly once with its approved revision`);
    }
  }

  for (const forbidden of ['continue-on-error:', 'if:', 'strategy:', 'matrix:', 'paths:', 'paths-ignore:']) {
    if (source.includes(forbidden)) {
      throw new GateError('workflow-contract', `workflow may not contain ${forbidden}`);
    }
  }
  return true;
}

export function verifySnapshotHead(expectedSha, actualSha) {
  if (!expectedSha || !actualSha || expectedSha !== actualSha) {
    throw new GateError(
      'snapshot-drift',
      `isolated snapshot SHA mismatch: expected ${expectedSha || '<missing>'}, got ${actualSha || '<missing>'}`,
    );
  }
}

export function assertCallerHeadUnchanged(expectedSha, actualSha) {
  if (!expectedSha || !actualSha || expectedSha !== actualSha) {
    throw new GateError(
      'caller-changed',
      `caller HEAD changed during run: ${expectedSha || '<missing>'} -> ${actualSha || '<missing>'}`,
    );
  }
}

function getRecordWorkflowName(record) {
  return record?.workflowName;
}

function findDuplicateIds(items) {
  const counts = new Map();
  for (const item of items) {
    if (typeof item?.id !== 'string') continue;
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

function successfulTask(tasks, id) {
  const matches = tasks.filter((task) => task?.id === id);
  return matches.length === 1 && matches[0].status === 'success' && matches[0].code === 0;
}

export function verifyRunRecord(record, {
  capturedHeadSha,
  runnerExitCode,
  runDirectoryName,
} = {}) {
  if (!record || typeof record !== 'object') {
    throw new GateError('run-record-malformed', 'run record is missing or not an object');
  }
  if (typeof record.run_id !== 'string' || record.run_id.length === 0 || (runDirectoryName && record.run_id !== runDirectoryName)) {
    throw new GateError('run-record-malformed', 'run record has no matching unique run_id');
  }
  if (getRecordWorkflowName(record) !== WORKFLOW_NAME) {
    throw new GateError('run-record-mismatch', `run record workflow is not ${WORKFLOW_NAME}`);
  }
  if (record.event !== LOCAL_TRIGGER) {
    throw new GateError('run-record-mismatch', `run record event is not ${LOCAL_TRIGGER}`);
  }
  if (record.workspace_mode !== 'worktree') {
    throw new GateError('run-record-mismatch', 'run record did not use the isolated worktree workspace');
  }
  if (record.headSha !== capturedHeadSha) {
    throw new GateError(
      'run-record-mismatch',
      `run record SHA mismatch: expected ${capturedHeadSha}, got ${record.headSha || '<missing>'}`,
    );
  }
  if (runnerExitCode !== 0 || record.exit_code !== 0) {
    throw new GateError(
      'runner-failed',
      `runner exit mismatch: process=${runnerExitCode}, record=${record.exit_code}`,
    );
  }
  if (record.state !== 'completed' || record.status !== 'completed' || record.conclusion !== 'success' || record.ok !== true) {
    throw new GateError('run-failed', 'run record does not certify a completed successful run');
  }

  const steps = Array.isArray(record.steps) ? record.steps : [];
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const duplicateSteps = findDuplicateIds(steps);
  if (duplicateSteps.length > 0) {
    throw new GateError('run-record-malformed', `run record contains duplicate step IDs: ${duplicateSteps.join(', ')}`);
  }
  for (const stepId of MANDATORY_STEP_IDS) {
    const fullId = `${JOB_ID}/${stepId}`;
    const matches = steps.filter((step) => step?.id === fullId);
    if (matches.length !== 1 || matches[0].status !== 'success') {
      throw new GateError('mandatory-step-failed', `mandatory step ${fullId} did not execute successfully`);
    }
    if (!successfulTask(tasks, fullId)) {
      throw new GateError('mandatory-task-failed', `mandatory task ${fullId} has no successful task record`);
    }
  }

  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  const qualityJobs = jobs.filter((job) => job?.id === JOB_ID);
  if (qualityJobs.length !== 1 || qualityJobs[0].status !== 'completed' || qualityJobs[0].conclusion !== 'success') {
    throw new GateError('job-failed', 'quality job is missing or was not successful');
  }
  const jobSteps = Array.isArray(qualityJobs[0].steps) ? qualityJobs[0].steps : [];
  for (const stepId of MANDATORY_STEP_IDS) {
    const matches = jobSteps.filter((step) => step?.name === stepId);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') {
      throw new GateError('mandatory-step-failed', `quality job step ${stepId} was skipped or failed`);
    }
  }
  return {
    runId: record.run_id,
    workflow: WORKFLOW_NAME,
    job: JOB_ID,
    steps: MANDATORY_STEP_IDS.map((id) => `${JOB_ID}/${id}`),
    headSha: record.headSha,
  };
}

export async function findRunRecords(runRoot) {
  let entries;
  try {
    entries = await readdir(runRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new GateError('run-record-read-failed', `cannot read run root ${runRoot}`, error);
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const recordPath = join(runRoot, entry.name, 'run.json');
    try {
      const source = await readFile(recordPath, 'utf8');
      let record;
      try {
        record = JSON.parse(source);
      } catch (error) {
        throw new GateError('run-record-malformed', `run record ${recordPath} is not valid JSON`, error);
      }
      records.push({ directoryName: entry.name, path: recordPath, record });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new GateError('run-record-malformed', `run directory ${entry.name} has no run.json`);
      }
      throw error;
    }
  }
  return records;
}

export function assertUniqueCurrentRun(records) {
  if (records.length === 0) {
    throw new GateError(
      'run-record-missing',
      `no new actrun run record was created for the forced ${LOCAL_TRIGGER} invocation`,
    );
  }
  if (records.length !== 1) {
    throw new GateError(
      'run-record-not-unique',
      `expected exactly one run record for this invocation, found ${records.length}`,
    );
  }
  return records[0];
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new GateError('configuration-invalid', `cannot read JSON file ${path}`, error);
  }
}

export async function assertExactToolchain(repoRoot, {
  expectedNodeVersion = EXPECTED_NODE_VERSION,
  expectedNpmVersion = EXPECTED_NPM_VERSION,
  expectedActrunVersion = EXPECTED_ACTRUN_VERSION,
  runnerPathOverride,
  npmVersionOverride,
} = {}) {
  const nodeVersion = (await readFile(join(repoRoot, '.node-version'), 'utf8')).trim();
  if (nodeVersion !== expectedNodeVersion) {
    throw new GateError('configuration-invalid', `.node-version must be ${expectedNodeVersion}`);
  }
  if (process.versions.node !== expectedNodeVersion) {
    throw new GateError(
      'wrong-node-version',
      `Node ${expectedNodeVersion} is required; running ${process.versions.node}`,
    );
  }

  let npmVersion = npmVersionOverride;
  if (!npmVersion) {
    try {
      npmVersion = (await runCommand('npm', ['--version'], { cwd: repoRoot })).stdout.trim();
    } catch (error) {
      throw new GateError('missing-npm', 'npm is required but could not be executed', error);
    }
  }
  if (npmVersion !== expectedNpmVersion) {
    throw new GateError('wrong-npm-version', `npm ${expectedNpmVersion} is required; running ${npmVersion}`);
  }

  const packageJson = await readJson(join(repoRoot, 'package.json'));
  const declared = packageJson.devDependencies?.['@mizchi/actrun'];
  if (declared !== expectedActrunVersion) {
    throw new GateError('actrun-not-pinned', `package.json must pin @mizchi/actrun to ${expectedActrunVersion}`);
  }
  const lockfile = await readJson(join(repoRoot, 'package-lock.json'));
  const locked = lockfile.packages?.['node_modules/@mizchi/actrun'];
  if (locked?.version !== expectedActrunVersion || !locked?.integrity || !locked?.resolved) {
    throw new GateError('actrun-not-pinned', `package-lock.json must lock @mizchi/actrun to ${expectedActrunVersion}`);
  }

  const runnerPath = runnerPathOverride ?? join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'actrun.cmd' : 'actrun');
  try {
    await access(runnerPath, constants.X_OK);
  } catch (error) {
    throw new GateError(
      'missing-runner',
      `pinned caller-installed actrun is missing at ${runnerPath}; refusing global/npx fallback`,
      error,
    );
  }
  const installed = await readJson(join(repoRoot, 'node_modules', '@mizchi', 'actrun', 'package.json'));
  if (installed.version !== expectedActrunVersion) {
    throw new GateError('actrun-not-pinned', `installed actrun is ${installed.version}, expected ${expectedActrunVersion}`);
  }
  return { runnerPath, npmVersion, nodeVersion, actrunVersion: installed.version };
}

export async function createSnapshot(repoRoot, capturedHeadSha) {
  const parent = await mkdtemp(join(tmpdir(), 'invariant-ci-local-'));
  const snapshot = join(parent, 'snapshot');
  try {
    await runGit(['worktree', 'add', '--detach', snapshot, capturedHeadSha], repoRoot);
    const actual = await runGit(['rev-parse', 'HEAD'], snapshot);
    verifySnapshotHead(capturedHeadSha, actual);
    return { parent, snapshot };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

export async function removeSnapshot(repoRoot, snapshotInfo) {
  if (!snapshotInfo) return;
  try {
    await runGit(['worktree', 'remove', '--force', snapshotInfo.snapshot], repoRoot);
  } finally {
    await rm(snapshotInfo.parent, { recursive: true, force: true });
  }
}

export function runActrunProcess(command, args, { cwd, timeoutMs, onChild } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    onChild?.(child);
    let finished = false;
    let timedOut = false;
    let forceKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
      forceKillTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
      forceKillTimer.unref?.();
    }, timeoutMs);
    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolvePromise({ exitCode: null, signal: null, error, timedOut });
    });
    child.once('close', (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolvePromise({ exitCode, signal, error: null, timedOut });
    });
  });
}

function terminateChild(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

export async function runGate({
  cwd = process.cwd(),
  timeoutMs = 10 * 60 * 1000,
  now = () => Date.now(),
  random = () => randomBytes(6).toString('hex'),
} = {}) {
  const repoRoot = resolve(await runGit(['rev-parse', '--show-toplevel'], cwd));
  const workflowPath = join(repoRoot, WORKFLOW_PATH);
  const workflowSource = await readFile(workflowPath, 'utf8').catch((error) => {
    throw new GateError('workflow-contract', `cannot read ${WORKFLOW_PATH}`, error);
  });
  validateWorkflowDefinition(workflowSource);
  const initialStatus = await assertCallerClean(repoRoot);
  const capturedHeadSha = await runGit(['rev-parse', 'HEAD'], repoRoot);
  const toolchain = await assertExactToolchain(repoRoot);
  const runRoot = join(repoRoot, '.actrun-runs', `ci-local-${capturedHeadSha}-${now()}-${random()}`);
  await mkdir(runRoot, { recursive: true });
  const snapshotInfo = await createSnapshot(repoRoot, capturedHeadSha);
  const command = [
    WORKFLOW_PATH,
    '--trigger', LOCAL_TRIGGER,
    '--workspace-mode', 'worktree',
    '--run-root', runRoot,
  ];
  let result;
  let primaryError;
  let interrupted = false;
  let child;
  const handleSignal = () => {
    interrupted = true;
    terminateChild(child);
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  try {
    result = await runActrunProcess(toolchain.runnerPath, ['workflow', 'run', ...command], {
      cwd: snapshotInfo.snapshot,
      timeoutMs,
      onChild: (created) => { child = created; },
    });
    if (interrupted || result.signal || result.timedOut) {
      primaryError = new GateError(
        result.timedOut ? 'timeout' : 'interrupted',
        result.timedOut
          ? `actrun exceeded the ${timeoutMs}ms bound and was terminated`
          : `actrun was interrupted${result.signal ? ` by ${result.signal}` : ''}`,
      );
    } else if (result.error) {
      primaryError = new GateError('runner-failed', `actrun could not start: ${result.error.message}`, result.error);
    } else {
      try {
        const records = await findRunRecords(runRoot);
        const current = assertUniqueCurrentRun(records);
        verifyRunRecord(current.record, {
          capturedHeadSha,
          runnerExitCode: result.exitCode,
          runDirectoryName: current.directoryName,
        });
      } catch (error) {
        primaryError = error;
      }
    }
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await removeSnapshot(repoRoot, snapshotInfo);
  }

  let finalStatusError;
  try {
    const finalHeadSha = await runGit(['rev-parse', 'HEAD'], repoRoot);
    assertCallerHeadUnchanged(capturedHeadSha, finalHeadSha);
    assertCleanStatus(await readCallerStatus(repoRoot));
  } catch (error) {
    finalStatusError = error;
  }
  if (finalStatusError && primaryError) {
    throw new GateError('caller-changed', `${primaryError.message}; ${finalStatusError.message}`, finalStatusError);
  }
  if (finalStatusError) throw finalStatusError;
  if (primaryError) throw primaryError;
  return {
    capturedHeadSha,
    runRoot,
    runnerPath: toolchain.runnerPath,
    result,
    initialStatus,
  };
}

export function formatFailure(error) {
  if (error instanceof GateError) return `${error.code}: ${error.message}`;
  return error?.message || String(error);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) {
    throw new GateError('usage', 'npm run ci:local accepts no runner flags or arguments');
  }
  const result = await runGate();
  process.stdout.write(`ci:local: PASS for ${result.capturedHeadSha}; run records: ${result.runRoot}\n`);
  return result;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`ci:local: FAIL: ${formatFailure(error)}\n`);
    process.exitCode = 1;
  }
}
