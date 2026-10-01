import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const source = new URL('../src/domain/calculation.ts', import.meta.url);
const manifest = new URL('../src/domain/calculation-source.ts', import.meta.url);
export async function calculationSourceHash() {
  return createHash('sha256').update(await readFile(source)).digest('hex');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--write' || process.argv.length !== 3) throw new Error('Usage: node scripts/calculation-source.mjs --write');
  const hash = await calculationSourceHash();
  await writeFile(manifest, `// Source identity only; not a proof of factual inputs or mathematical correctness.\nexport const CALCULATION_SOURCE_HASH = '${hash}' as const;\n`);
  console.log(`Updated ${fileURLToPath(manifest)}`);
}
