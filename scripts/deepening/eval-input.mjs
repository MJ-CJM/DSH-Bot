import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { z } = createRequire(resolve(root, 'packages/dsh-bot/package.json'))('zod');
export const sha256 = data => createHash('sha256').update(data).digest('hex');
const files = ['memory-0', 'memory-1', 'memory-2', 'memory-3', 'memory-4',
  'workflow-0', 'workflow-1', 'workflow-2', 'workflow-3', 'injection-0', 'injection-1', 'injection-2', 'injection-3']
  .map(name => `evals/cases/offline/${name}.json`);
const allowlist = new Set([...files, 'evals/manifests/offline.json', 'evals/manifests/failures.json',
  ...['eval-manifest', 'eval-fixture', 'manifest', 'case'].map(name => `evals/schemas/${name}.json`)]);
async function read(path, hash) {
  if (!allowlist.has(path)) throw Error('Synthetic input not allowlisted');
  const full = resolve(root, path);
  if (await realpath(full) !== full) throw Error('Symlink input rejected');
  const bytes = await readFile(full);
  if (hash && sha256(bytes) !== hash) throw Error(`Synthetic input digest mismatch: ${path}`);
  return JSON.parse(bytes);
}
export async function loadEvaluation() {
  const manifestSchema = z.fromJSONSchema(await read('evals/schemas/eval-manifest.json'));
  const fixtureSchema = z.fromJSONSchema(await read('evals/schemas/eval-fixture.json'));
  const manifest = manifestSchema.parse(await read('evals/manifests/offline.json'));
  // Reuse M1's frozen manifest schema and provenance identifiers; do not reinterpret history as model evaluation.
  const catalogSchema = z.fromJSONSchema(await read('evals/schemas/manifest.json'));
  const catalog = catalogSchema.parse(await read(manifest.catalog.path, manifest.catalog.sha256));
  const catalogIds = new Set(catalog.cases.map(row => row.id));
  if (manifest.files.length !== files.length || new Set(manifest.files.map(row => row.path)).size !== files.length ||
    manifest.files.some(row => !files.includes(row.path))) throw Error('Synthetic file inventory changed');
  const cases = [], responses = new Map();
  for (const entry of manifest.files) {
    const fixture = fixtureSchema.parse(await read(entry.path, entry.sha256));
    for (const item of fixture.cases) {
      if (!catalogIds.has(item.catalogCaseId)) throw Error('Unknown M1 provenance');
      if (item.kind === 'memory' && (!item.gold.relevant?.length || !item.gold.temporal || !item.input.candidates ||
        item.input.at === undefined)) throw Error('Missing memory scoring contract');
      if (item.kind === 'workflow' && (!item.gold.terminal || item.gold.sideEffects === undefined)) throw Error('Missing workflow gold');
      if (item.kind === 'injection' && (item.gold.authorized === undefined || !item.gold.canary)) throw Error('Missing injection gold');
      cases.push(item);
    }
    for (const row of fixture.responses) {
      if (responses.has(row.id)) throw Error('Duplicate replay response'); responses.set(row.id, row.response);
    }
  }
  const ids = cases.map(row => row.id);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(manifest.caseIds) ||
    responses.size !== ids.length || ids.some(id => !responses.has(id))) throw Error('Case/response inventory mismatch');
  return { manifest, cases, responses };
}
