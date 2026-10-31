import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const inputPath = 'evals/inputs/failures.json';
export const manifestPath = 'evals/manifests/failures.json';
export const pattern = { expression: 'FAIL|NOT_RUN|返工|根因', flags: 'i', unit: 'matching-line' };
export const sha256 = text => createHash('sha256').update(text).digest('hex');
export function inside(path) {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error(`Outside repository: ${path}`);
  return full;
}
export const read = path => readFile(inside(path), 'utf8');
export const readJson = async path => JSON.parse(await read(path));
export async function writeJson(path, value, exclusive = false) {
  const full = inside(path);
  await mkdir(resolve(full, '..'), { recursive: true });
  await writeFile(full, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w' });
}
export const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8_000_000 });
export async function discover() {
  const acceptance = (await readdir(inside('docs/acceptance'))).filter(p => p.endsWith('.md'))
    .map(p => `docs/acceptance/${p}`);
  const reviews = [];
  async function walk(path) {
    for (const item of await readdir(inside(path), { withFileTypes: true })) {
      const child = `${path}/${item.name}`;
      if (item.isDirectory()) await walk(child);
      else if (item.name.startsWith('R-review')) reviews.push(child);
    }
  }
  await walk('tasks');
  const excluded = (await readdir(inside('docs/acceptance'))).filter(p => !p.endsWith('.md'))
    .map(path => ({ path: `docs/acceptance/${path}`, reason: 'File inventory, not an acceptance narrative' }));
  return { paths: [...acceptance, ...reviews, '.codex/runs/PROGRESS.md'].sort(), excluded };
}
export function extract(sources, texts) {
  const rows = [];
  for (const source of sources) {
    const lines = texts.get(source.path).split(/\r?\n/);
    lines.forEach((text, index) => {
      if (!new RegExp(pattern.expression, pattern.flags).test(text)) return;
      rows.push({ id: `FC-${String(rows.length + 1).padStart(4, '0')}`,
        source: { path: source.path, revision: source.revision, lines: [index + 1, index + 1] },
        evidenceLevel: 'SOURCE', text });
    });
  }
  return rows;
}
// Git objects are immutable. Cache only revision-qualified blobs, never working files/snapshots.
const blobs = new Map();
export function frozenBlob(revision, path) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected frozen full Git SHA');
  const key = `${revision}:${path}`;
  if (!blobs.has(key)) blobs.set(key, git('show', key));
  return blobs.get(key);
}
export async function frozenTexts(input) {
  const texts = new Map();
  for (const source of input.sources) {
    const text = source.snapshot ? await read(source.snapshot) : frozenBlob(source.revision, source.path);
    if (sha256(text) !== source.sha256) throw new Error(`Frozen source hash mismatch: ${source.path}`);
    if (text.split(/\r?\n/).length !== source.lineCount) throw new Error(`Frozen source lines: ${source.path}`);
    texts.set(source.path, text);
  }
  return texts;
}
export async function catalog(input, texts) {
  texts ??= await frozenTexts(input);
  const candidates = extract(input.sources, texts);
  if (JSON.stringify(candidates) !== JSON.stringify(input.candidates)) throw new Error('Frozen candidate inventory mismatch');
  const live = await discover();
  const added = live.paths.filter(p => !texts.has(p));
  const removed = [...texts.keys()].filter(p => !live.paths.includes(p));
  const changed = [];
  for (const path of live.paths.filter(p => texts.has(p))) {
    if (sha256(await read(path)) !== sha256(texts.get(path))) changed.push(path);
  }
  return { baselineSha: input.baselineSha, sources: input.sources.length, candidates: candidates.length,
    historicalEstimate: 306, difference: candidates.length - 306,
    delta: { added, removed, changed }, excluded: input.excluded };
}
