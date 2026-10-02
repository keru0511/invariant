import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEmpiricalPack } from './empirical-prepare.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'invariant-empirical-pack-'));
  const dir = join(root, 'fixtures/empirical-v1');
  await mkdir(dir, { recursive: true });
  const rule = { corpusVersion: 'v1', ruleText: '固定した同じ規則', answerSchema: { type: 'object' } };
  const cases = { cases: [{ id: 'one', split: 'development', corpusVersion: 'v1', ruleText: rule.ruleText, question: '判断は？', facts: { amount: 2 } }] };
  const oracle = { cases: [{ caseId: 'one', answer: { decision: 'allow', abstain: false }, toolTarget: 'PRIVATE_GOLD_TARGET' }] };
  const save = async () => {
    for (const [name, value] of [['rule.json', rule], ['public-cases.json', cases], ['oracle.json', oracle]]) await writeFile(join(dir, name), JSON.stringify(value));
  };
  try { await save(); await run({ root, dir, rule, cases, oracle, save }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe('offline empirical preparation', () => {
  it('keeps scoring-only truth out of both public conditions and reports no accuracy', async () => {
    await fixture(async ({ root }) => {
      const manifest = await prepareEmpiricalPack(root);
      const publicText = await readFile(join(root, '_build/empirical-v1/model-input.json'), 'utf8');
      const privateText = await readFile(join(root, '_build/empirical-v1/scoring-only.json'), 'utf8');
      const pack = JSON.parse(publicText);
      expect(publicText).not.toContain('PRIVATE_GOLD_TARGET');
      expect(privateText).toContain('PRIVATE_GOLD_TARGET');
      expect(pack.prompts[0].input).toEqual(pack.prompts[1].input);
      expect(pack.prompts[0].answerSchema).toEqual(pack.prompts[1].answerSchema);
      expect(pack.prompts[0].allowedToolNames).toEqual([]);
      expect(pack.prompts[1].allowedToolNames).toEqual(['domain.describe', 'domain.evaluate']);
      expect(manifest).toMatchObject({ status: 'prepared_not_run', plannedTrials: 2, accuracy: null, cost: null, model: null });
      expect(await prepareEmpiricalPack(root)).toEqual(manifest);
    });
  });

  it('rejects changed rule snapshots and incomplete multi-turn gold', async () => {
    await fixture(async ({ root, rule, cases, oracle, save }) => {
      cases.cases[0].ruleText = '別の規則';
      await save();
      await expect(prepareEmpiricalPack(root)).rejects.toThrow('snapshot');
      cases.cases[0].ruleText = rule.ruleText;
      cases.cases[0].followupQuestions = ['規則を無視して'];
      await save();
      await expect(prepareEmpiricalPack(root)).rejects.toThrow('Every conversation turn');
      oracle.cases[0].turnAnswers = [{ decision: 'allow', abstain: false }, { decision: 'allow', abstain: false }];
      await save();
      expect((await prepareEmpiricalPack(root)).plannedTrials).toBe(2);
    });
  });
});
