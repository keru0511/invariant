import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localEnvironment, localConfig, devArguments, seedSql, sqlString, comparable, mcp, evaluateCases, evaluateReliabilityCases, knowledgeSeedSql, acquireLock, ROOT } from './local-lab.mjs';

describe('ローカルMCP検証環境', () => {
  it('本番の資格情報やリモート設定を子プロセスへ引き継がない', () => {
    const env = localEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'secret', CLOUDFLARE_API_TOKEN: 'secret', WRANGLER_REMOTE: 'true' });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.WRANGLER_REMOTE).toBeUndefined();
    expect(env.WRANGLER_SEND_METRICS).toBe('false');
  });
  it('localhostとローカル永続領域に固定し、外部LLMの設定を持たない', () => {
    const args = devArguments(8787);
    expect(args).toContain('--local'); expect(args).not.toContain('--remote');
    expect(args[args.indexOf('--ip') + 1]).toBe('127.0.0.1');
    const config = localConfig('run-1');
    expect(config.vars.INVARIANT_ENVIRONMENT).toBe('test');
    expect(config.vars.OPENAI_API_KEY).toBe('');
    expect(config.d1_databases[0].database_id).toBe('00000000-0000-0000-0000-000000000000');
  });
  it('SQL文字列をエスケープし既存バージョンを上書きしない', () => {
    expect(sqlString("a'b")).toBe("'a''b'");
    const sql = seedSql({ name: "a'b" }, 'v1');
    expect(sql).toContain('INSERT OR IGNORE INTO domain_versions');
    expect(sql).not.toContain('DELETE'); expect(sql).not.toContain('REPLACE');
  });
  it('意味上の判定と診断を比較し、トレースは別途決定性で検証する', () => {
    expect(comparable({ status: 'resolved', decision: 'deny', value: false, errors: [{ code: 'X', message: 'text' }] }))
      .toEqual({ status: 'deny', value: false, matchedRuleIds: undefined, unresolvedPaths: undefined,
        errors: [{ code: 'X', path: undefined, nodeId: undefined, ruleIds: undefined }] });
  });
  it('別プロセスのサーバーや不正な応答を成功扱いしない', async () => {
    await expect(mcp('http://127.0.0.1:8787', 'domain.ping', {}, 'ours', async () => new Response('{}'))).rejects.toThrow();
    await expect(mcp('http://127.0.0.1:8787', 'domain.ping', {}, 'ours', async () => new Response(JSON.stringify({ error: { code: -1 } }), { headers: { 'x-invariant-local-lab': 'ours' } }))).rejects.toThrow('MCP');
  });
  it('modern MCPのメタデータとヘッダーを送る', async () => {
    let sent;
    const value = await mcp('http://127.0.0.1:8787', 'domain.ping', {}, 'ours', async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }), { headers: { 'x-invariant-local-lab': 'ours' } });
    });
    expect(value).toEqual({ ok: true });
    expect(sent.init.redirect).toBe('error');
    expect(sent.init.headers['Mcp-Name']).toBe('domain.ping');
    expect(sent.body.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
  });
  it('通信失敗をケースごとの失敗として残す', async () => {
    const catalog = JSON.parse(await readFile(join(ROOT, 'fixtures/domain-v0/functions.json'), 'utf8'));
    const result = await evaluateCases({ catalog, version: 'v', runId: 'x' }, 'http://127.0.0.1:8787', async () => { throw new Error('connection failed'); });
    expect(result).toHaveLength(8);
    expect(result.every((c) => !c.passed && c.error === 'connection failed')).toBe(true);
  });
  it('同じ環境での同時起動を拒否し、正常終了後に再取得できる', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-lab-lock-'));
    try {
      const release = await acquireLock(directory);
      await expect(acquireLock(directory)).rejects.toThrow('別のローカル検証');
      await release();
      const releaseAgain = await acquireLock(directory); await releaseAgain();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

 it('records every reliability case as failed when transport is unavailable', async () => {
   const cases = await evaluateReliabilityCases({ version: 'v', runId: 'ours' }, 'http://127.0.0.1:8787', async () => { throw new Error('offline'); });
   expect(cases).toHaveLength(5);
   expect(cases.every((item) => !item.passed && item.error === 'offline')).toBe(true);
 });
 it('seeds distinct immutable unknown/conflict snapshots with matching publication markers', () => {
   const sql = knowledgeSeedSql({ functions: [] }, 'v1');
   expect(sql).toContain('domain_proposals');
   expect(sql).toContain('v1-unknown');
   expect(sql).toContain('v1-conflict');
   expect(sql).not.toMatch(/DELETE|REPLACE|UPDATE/);
 });
