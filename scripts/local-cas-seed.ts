import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packCatalog } from '../src/persistence/domain-objects';

const version = process.argv[2];
if (!version || !/^fixture-[a-f0-9]+$/.test(version)) throw new Error('Expected local fixture version.');
const catalog = JSON.parse(await readFile(join(process.cwd(), 'fixtures/domain-v0/functions.json'), 'utf8'));
const changed = structuredClone(catalog);
for (const rule of changed.functions[0].policy.rules) rule.when.right.value = 21;
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
let sql = "INSERT OR IGNORE INTO domains VALUES ('local-lab','demo-cas','CAS synthetic demo','local-fixture');\n";
for (const [index, model] of [catalog, changed].entries()) {
  const packed = await packCatalog(model);
  const id = `${version}-cas-${index + 1}`;
  for (const item of packed.objects) sql += `INSERT OR IGNORE INTO domain_objects VALUES ('local-lab','demo-cas',${quote(item.hash)},${quote(item.payload)});\n`;
  sql += `INSERT OR IGNORE INTO domain_versions (workspace_id,domain_id,version_id,model_json,published_at,parent_version_id)
    VALUES ('local-lab','demo-cas',${quote(id)},${quote(packed.catalogPointer)},'local-fixture',${index === 0 ? 'NULL' : quote(version + '-cas-1')});\n`;
}
process.stdout.write(sql);
