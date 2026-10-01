import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL = '2026-07-28';
export const WORKSPACE = 'local-lab';
export const DOMAIN = 'demo';
const LAB = join(ROOT, '_build', 'local-lab');
const CONFIG = join(LAB, 'wrangler.json');
const STATE = join(LAB, 'state');
const activeChildren = new Set();
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export function localEnvironment(parent = process.env) {
  // Deliberately do not inherit API keys, Cloudflare credentials or remote flags.
  return {
    PATH: parent.PATH ?? '', HOME: join(LAB, 'home'),
    XDG_CONFIG_HOME: join(LAB, 'home', 'config'),
    XDG_CACHE_HOME: join(LAB, 'home', 'cache'),
    WRANGLER_LOG_PATH: join(LAB, 'wrangler.log'),
    WRANGLER_SEND_METRICS: 'false', CI: 'true', BROWSER: 'none',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    ...(parent.SystemRoot ? { SystemRoot: parent.SystemRoot } : {}),
  };
}

export function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
export function seedSql(catalog, version) {
  return `INSERT OR IGNORE INTO workspaces VALUES ('${WORKSPACE}', 'local-fixture');
INSERT OR IGNORE INTO domains VALUES ('${WORKSPACE}', '${DOMAIN}', 'Local synthetic demo', 'local-fixture');
INSERT OR IGNORE INTO workspace_memberships VALUES ('${WORKSPACE}', 'test-bypass', 'local-fixture');
INSERT OR IGNORE INTO domain_versions (workspace_id, domain_id, version_id, model_json, published_at)
VALUES ('${WORKSPACE}', '${DOMAIN}', ${sqlString(version)}, ${sqlString(JSON.stringify(catalog))}, 'local-fixture');\n`;
}
export function localConfig(runId) {
  return {
    name: 'invariant-local-lab', main: './entry.ts', compatibility_date: '2024-12-01',
    compatibility_flags: ['nodejs_compat'], workers_dev: false,
    vars: { INVARIANT_ENVIRONMENT: 'test', MCP_AUTH_MODE: 'test-bypass', LAB_RUN_ID: runId,
      OPENAI_API_KEY: '', OPENAI_MODEL: '', OPENAI_BASE_URL: 'http://127.0.0.1:1' },
    d1_databases: [{ binding: 'DB', database_name: 'invariant-local-lab',
      database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: '../../migrations' }],
  };
}
async function assertNoSecretFiles(directory) {
  const names = await readdir(directory);
  if (names.some((name) => /^(?:\.dev\.vars|\.env)(?:\.|$)/.test(name) && !name.endsWith('.example'))) {
    throw new Error('ローカル検証用ディレクトリに .env / .dev.vars があるため停止しました。資格情報を混ぜない専用checkoutを使ってください。');
  }
}
function launch(args, output = 'pipe') {
  const child = spawn(process.execPath, [WRANGLER, ...args], {
    cwd: LAB, env: localEnvironment(), stdio: ['ignore', output, output],
    detached: process.platform !== 'win32',
  });
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
  return child;
}
function exited(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}
async function wrangler(args) {
  const child = launch(args);
  const done = exited(child);
  let log = '';
  child.stdout.on('data', (chunk) => { log = (log + chunk).slice(-500_000); });
  child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-500_000); });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void stop(child); }, 60_000);
  let result;
  try { result = await done; } finally { clearTimeout(timeout); }
  if (timedOut) throw new Error('ローカルDB準備がタイムアウトしました');
  await writeFile(join(LAB, 'setup-last.log'), log, 'utf8');
  if (result.code !== 0) throw new Error(`ローカルDB準備に失敗しました（${result.code ?? result.signal}）。_build/local-lab/setup-last.log を確認してください。`);
}
export async function setup() {
  await mkdir(LAB, { recursive: true });
  await mkdir(join(LAB, 'home'), { recursive: true });
  await assertNoSecretFiles(ROOT);
  await assertNoSecretFiles(LAB);
  const runId = randomUUID();
  const catalog = JSON.parse(await readFile(join(ROOT, 'fixtures/domain-v0/functions.json'), 'utf8'));
  const version = 'fixture-' + createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 16);
  await writeFile(CONFIG, JSON.stringify(localConfig(runId), null, 2) + '\n');
  // Only this generated dev entry point uses the test bypass. Production files
  // and wrangler.jsonc are never rewritten. Never deploy or tunnel this config.
  await writeFile(join(LAB, 'entry.ts'), `import worker from '../../src/worker/index';
export default { async fetch(request, env, ctx) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.url).hostname)) return new Response('Local only', {status:403});
  const response = await worker.fetch(request, env, ctx);
  const headers = new Headers(response.headers);
  headers.set('x-invariant-local-lab', env.LAB_RUN_ID);
  return new Response(response.body, {status:response.status, headers});
} };\n`);
  await writeFile(join(LAB, 'seed.sql'), seedSql(catalog, version));
  const common = ['--local', '--config', CONFIG, '--persist-to', STATE];
  await wrangler(['d1', 'migrations', 'apply', 'DB', ...common]);
  await wrangler(['d1', 'execute', 'DB', ...common, '--file', join(LAB, 'seed.sql')]);
  return { runId, version, catalog };
}

async function freePort(preferred = 0) {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(preferred, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}
export function devArguments(port) {
  return ['dev', '--local', '--config', CONFIG, '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', '0', '--persist-to', STATE, '--show-interactive-dev-session=false'];
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = exited(child);
  const kill = (signal) => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  kill('SIGTERM');
  if (await Promise.race([done.then(() => true), delay(3000).then(() => false)]) === false) {
    kill('SIGKILL'); await done;
  }
}
export async function mcp(baseUrl, name, args, runId, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/mcp`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json',
      Origin: 'http://localhost:5173', 'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': 'tools/call', 'Mcp-Name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'local-lab', method: 'tools/call', params: {
      name, arguments: args, _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'invariant-local-lab', version: '1' },
      },
    } }),
  });
  if (!response.ok || response.headers.get('x-invariant-local-lab') !== runId) throw new Error('ローカルMCPサーバーの応答を確認できません');
  const envelope = await response.json();
  if (envelope.error) throw new Error(`MCPエラー: ${envelope.error.code}`);
  const text = envelope.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCPツール応答がありません');
  return JSON.parse(text);
}
export function comparable(result) {
  return {
    status: result.status === 'resolved' ? result.decision : result.status,
    value: result.value, matchedRuleIds: result.matchedRuleIds,
    unresolvedPaths: result.unresolvedPaths,
    errors: result.errors?.map(({ code, path, nodeId, ruleIds }) => ({ code, path, nodeId, ruleIds })),
  };
}
export async function evaluateCases(context, baseUrl, call = mcp) {
  const manifest = JSON.parse(await readFile(join(ROOT, 'fixtures/domain-v0/manifest.json'), 'utf8'));
  const cases = [];
  for (const entry of manifest.fixtures) {
    const fixture = JSON.parse(await readFile(join(ROOT, 'fixtures/domain-v0', entry.path), 'utf8'));
    const fn = context.catalog.functions.find((f) => f.id === fixture.functionId);
    try {
      const args = { workspace: WORKSPACE, domain: DOMAIN, version: context.version, function: fn.name, args: fixture.input };
      const actual = await call(baseUrl, 'domain.evaluate', args, context.runId);
      const repeated = await call(baseUrl, 'domain.evaluate', args, context.runId);
      const expected = comparable(fixture.expected);
      const observed = comparable(actual);
      const deterministic = JSON.stringify(actual) === JSON.stringify(repeated);
      cases.push({ id: fixture.id, passed: deterministic && JSON.stringify(expected) === JSON.stringify(observed),
        deterministic, expected, actual: observed });
    } catch (error) { cases.push({ id: fixture.id, passed: false, error: error.message }); }
  }
  return cases;
}
async function ready(baseUrl, child, runId) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('開発サーバーが起動前に終了しました');
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.ok && response.headers.get('x-invariant-local-lab') === runId) return;
    } catch { /* Wait for the locally-owned server, never attach to another process. */ }
    await delay(250);
  }
  throw new Error('開発サーバーの起動がタイムアウトしました');
}
async function saveReport(report) {
  const directory = join(LAB, 'reports'); await mkdir(directory, { recursive: true });
  const name = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8) + '.json';
  await writeFile(join(directory, name), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(LAB, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
}
export async function acquireLock(directory = LAB) {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, 'active.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('別のローカル検証が実行中です。終了後に再試行してください。異常終了後はactive.lockの所有PIDが停止済みか確認してください。');
    throw error;
  }
  await writeFile(join(lock, 'pid'), String(process.pid));
  return async () => { await rm(lock, { recursive: true }); };
}
export async function run(mode) {
  if (!['setup', 'start', 'check'].includes(mode)) throw new Error('使い方: npm run lab:setup / lab:start / lab:check');
  const releaseLock = await acquireLock();
  let child, log = '', cancelled = false;
  const report = { mode, source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0 }, startedAt: new Date().toISOString(), status: 'failed', cases: [] };
  const signals = ['SIGINT', 'SIGTERM'];
  const interrupted = () => { cancelled = true; process.exitCode = 130; void Promise.all([...activeChildren].map(stop)); };
  signals.forEach((signal) => process.once(signal, interrupted));
  try {
    const context = await setup(); report.version = context.version;
    if (cancelled) throw new Error('検証を中断しました');
    if (mode === 'setup') { console.log('ローカルDBを準備しました'); return; }
    const port = await freePort(mode === 'start' ? 8787 : 0);
    const baseUrl = `http://127.0.0.1:${port}`;
    child = launch(devArguments(port));
    child.on('error', (error) => { log += error.message; });
    child.stdout.on('data', (chunk) => { log = (log + chunk).slice(-500_000); });
    child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-500_000); });
    await ready(baseUrl, child, context.runId);
    if (mode === 'start') {
      console.log(`ローカルMCP起動: ${baseUrl}/mcp\nテスト認証専用です。外部公開・トンネル接続は禁止。終了はCtrl+C`);
      const result = await exited(child);
      if (!cancelled && result.code !== 0) throw new Error('開発サーバーが異常終了しました。server-last.logを確認してください。');
      return;
    }
    const identity = { workspace: WORKSPACE, domain: DOMAIN, version: context.version };
    if (!(await mcp(baseUrl, 'domain.ping', {}, context.runId)).ok) throw new Error('ping失敗');
    const schema = await mcp(baseUrl, 'domain.describe', identity, context.runId);
    const valid = await mcp(baseUrl, 'domain.validate', identity, context.runId);
    const search = await mcp(baseUrl, 'domain.search', { workspace: WORKSPACE, query: 'Local synthetic', limit: 10 }, context.runId);
    if (!schema.ok || !valid.valid || !search.ok || search.results.length !== context.catalog.functions.length) throw new Error('保存済みドメインの参照検証に失敗');
    const foreign = await mcp(baseUrl, 'domain.describe', { ...identity, workspace: 'foreign-workspace' }, context.runId);
    if (foreign.errors?.[0]?.code !== 'RESOURCE_NOT_FOUND') throw new Error('ワークスペース分離の検証に失敗');
    report.cases = await evaluateCases(context, baseUrl);
    report.status = report.cases.length > 0 && report.cases.every((item) => item.passed) ? 'passed' : 'failed';
  } catch (error) { report.error = error.message; }
  finally {
    if (child) await stop(child);
    signals.forEach((signal) => process.removeListener(signal, interrupted));
    await mkdir(LAB, { recursive: true });
    await writeFile(join(LAB, 'server-last.log'), log);
    report.finishedAt = new Date().toISOString();
    try { if (mode === 'check') await saveReport(report); } finally { await releaseLock(); }
  }
  if (mode === 'check') {
    console.log(`${report.status}: ${report.cases.filter((c) => c.passed).length}/${report.cases.length} cases; _build/local-lab/latest.json`);
    if (report.status !== 'passed') process.exitCode = cancelled ? 130 : 1;
  } else if (report.error) throw new Error(report.error);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) { console.error('指定できる引数は setup / start / check の1つです'); process.exitCode = 2; }
  else run(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
