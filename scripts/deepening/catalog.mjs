import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalog, discover, extract, git, inputPath, inside, pattern, readJson, sha256, writeJson } from './catalog-lib.mjs';

export async function freeze() {
  const baselineSha = git('rev-parse', 'HEAD').trim();
  const { paths, excluded } = await discover();
  const sources = [];
  const texts = new Map();
  for (const path of paths) {
    const text = await readFile(inside(path), 'utf8');
    let revision = baselineSha;
    let snapshot;
    if (path === '.codex/runs/PROGRESS.md') {
      snapshot = 'evals/inputs/failures-progress.md';
      revision = `snapshot:${sha256(text)}`;
      await mkdir(resolve(inside(snapshot), '..'), { recursive: true });
      await writeFile(inside(snapshot), text, { flag: 'wx' });
    } else if (git('show', `${baselineSha}:${path}`) !== text) {
      throw new Error(`Refusing to freeze a modified tracked source: ${path}`);
    }
    texts.set(path, text);
    sources.push({ path, revision, sha256: sha256(text), lineCount: text.split(/\r?\n/).length,
      ...(snapshot ? { snapshot } : {}) });
  }
  const input = { schemaVersion: 1, baselineSha, pattern, sources, excluded, candidates: extract(sources, texts) };
  await writeJson(inputPath, input, true);
  return input;
}
export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--freeze')) throw new Error('Usage: catalog.mjs [--freeze] (never overwrites a freeze)');
  const input = args.includes('--freeze') ? await freeze() : await readJson(inputPath);
  const summary = await catalog(input);
  await writeJson('.dsh-dev/deepening/b2/catalog.json', summary);
  console.log(JSON.stringify(summary, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
