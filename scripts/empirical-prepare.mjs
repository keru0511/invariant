import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (text) => createHash('sha256').update(text).digest('hex');

/** Prepare reproducible, separate public-input and scoring packs. No model,
 * tool execution, credentials, network, or claimed accuracy is involved. */
export async function prepareEmpiricalPack(root = ROOT, output = join(root, '_build/empirical-v1')) {
  const dir = join(root, 'fixtures/empirical-v1');
  const texts = await Promise.all(['rule.json', 'public-cases.json', 'oracle.json'].map((name) => readFile(join(dir, name), 'utf8')));
  const [rule, publicCases, oracle] = texts.map((text) => JSON.parse(text));
  if (!rule.answerSchema || !Array.isArray(publicCases.cases) || !Array.isArray(oracle.cases)) throw new Error('Incomplete empirical fixtures.');
  const ids = publicCases.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length || new Set(oracle.cases.map((item) => item.caseId)).size !== oracle.cases.length) throw new Error('Duplicate empirical case IDs.');
  if (oracle.cases.length !== ids.length || ids.some((id) => !oracle.cases.some((item) => item.caseId === id))) throw new Error('Case/oracle set mismatch.');
  for (const item of publicCases.cases) {
    if (item.ruleText !== rule.ruleText || item.corpusVersion !== rule.corpusVersion) throw new Error('Public rule snapshot differs between cases.');
    if (item.followupQuestions?.length) {
      const expected = oracle.cases.find((entry) => entry.caseId === item.id);
      if (expected.turnAnswers?.length !== item.followupQuestions.length + 1) throw new Error('Every conversation turn needs an independent expected answer.');
    }
  }
  const conditions = ['natural_language', 'executable_rules'];
  const prompts = [];
  for (const [index, item] of publicCases.cases.entries()) {
    const order = index % 2 === 0 ? conditions : [...conditions].reverse();
    for (const condition of order) prompts.push({
      trialId: `${item.id}:${condition}:0`, caseId: item.id, split: item.split,
      condition, seed: 0, corpusVersion: item.corpusVersion,
      input: { question: item.question, facts: item.facts, ruleText: item.ruleText },
      followupQuestions: item.followupQuestions ?? [], answerSchema: rule.answerSchema,
      allowedToolNames: condition === 'executable_rules' ? ['domain.describe', 'domain.evaluate'] : [],
    });
  }
  const modelInput = { schemaVersion: 'empirical-prepared-input-v1', status: 'prepared_not_run', model: null, prompts };
  const scoringOnly = { schemaVersion: 'empirical-prepared-oracle-v1', warning: 'Never include this file in model requests or retrieval indexes.', oracle };
  const manifest = {
    schemaVersion: 'empirical-prepared-manifest-v1', status: 'prepared_not_run', plannedTrials: prompts.length,
    accuracy: null, cost: null, model: null,
    sourceHashes: Object.fromEntries(['rule.json', 'public-cases.json', 'oracle.json'].map((name, i) => [name, hash(texts[i])])),
    inputHash: hash(JSON.stringify(modelInput)), oracleHash: hash(JSON.stringify(scoringOnly)),
    confirmationNeeded: ['model/provider', 'sending synthetic experiment data', 'maximum trials', 'usage and total cost limit'],
    caveats: ['No model or tool has been run.', 'Reserved evaluation is a planned split, not measured held-out performance.', 'Structured matches do not certify final prose or conversation safety.'],
  };
  await mkdir(output, { recursive: true });
  for (const [name, value] of [['model-input.json', modelInput], ['scoring-only.json', scoringOnly], ['manifest.json', manifest]]) {
    await writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareEmpiricalPack().then((manifest) => {
    console.log(`Prepared ${manifest.plannedTrials} trial inputs. No model calls; accuracy and cost are unmeasured.`);
    console.log('_build/empirical-v1/model-input.json and scoring-only.json are separate.');
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
