import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { catalog, frozenTexts, frozenBlob, inputPath, inside, manifestPath, pattern, read, readJson, sha256,
  writeJson } from './catalog-lib.mjs';

// Use the existing exact Zod dependency from the owning workspace package. No new dependency,
// provider import, network access or globally installed validator is needed.
const { z } = createRequire(pathToFileURL(inside('packages/dsh-bot/package.json')))('zod');
const check = (condition, message) => { if (!condition) throw new Error(message); };
function unique(values, label) {
  check(new Set(values).size === values.length, `Duplicate ${label}`);
}
export async function schemas() {
  return { case: z.fromJSONSchema(await readJson('evals/schemas/case.json')),
    manifest: z.fromJSONSchema(await readJson('evals/schemas/manifest.json')) };
}
export async function loadBundle() {
  const manifest = await readJson(manifestPath);
  return { manifest, cases: await Promise.all(manifest.cases.map(item => readJson(item.path))) };
}
export async function validateBundle(bundle, { receipts = false } = {}) {
  bundle ??= await loadBundle();
  const schema = await schemas();
  const manifest = schema.manifest.parse(bundle.manifest);
  const cases = bundle.cases.map(value => schema.case.parse(value));
  const input = await readJson(inputPath);
  check(manifest.input === inputPath && manifest.inputSha256 === sha256(await read(inputPath)), 'Frozen input digest');
  check(manifest.baselineSha === input.baselineSha, 'Baseline SHA mismatch');
  check(isDeepStrictEqual(input.pattern, pattern), 'Candidate matching rule changed');
  const texts = await frozenTexts(input);
  const inventory = await catalog(input, texts);
  check(manifest.actualCandidates === inventory.candidates, 'Candidate count mismatch');
  const expectedSources = input.sources.map(({ path, revision, sha256 }) => ({ path, revision, sha256 }));
  check(isDeepStrictEqual(manifest.sources, expectedSources), 'Frozen source inventory mismatch');
  unique(manifest.supplementalSources.map(source => source.path), 'supplemental source');
  for (const source of manifest.supplementalSources) {
    check(!texts.has(source.path), 'Supplemental source duplicates frozen source');
    inside(source.path);
    check(source.revision === manifest.baselineSha, 'Unfrozen supplemental revision');
    const text = frozenBlob(source.revision, source.path);
    check(sha256(text) === source.sha256, `Supplemental source digest: ${source.path}`);
    texts.set(source.path, text);
  }
  unique(cases.map(c => c.id), 'case ID');
  unique(cases.map(c => c.rootCause), 'root cause');
  unique(manifest.cases.map(c => c.id), 'manifest case ID');
  check(cases.length === manifest.cases.length, 'Case inventory mismatch');
  const diskCases = (await readdir(inside('evals/cases/failures'))).filter(path => path.endsWith('.json')).sort();
  check(isDeepStrictEqual(diskCases, manifest.cases.map(c => `${c.id}.json`).sort()), 'Unlisted/missing case artifact');
  for (const entry of manifest.cases) {
    check(entry.path === `evals/cases/failures/${entry.id}.json`, 'Case path/ID mismatch');
    const c = cases.find(c => c.id === entry.id);
    check(c && c.status === entry.status, `Case status mismatch: ${entry.id}`);
    // Validate supplied negative-test mutations too, rather than silently reloading them from disk.
    const onDisk = await read(entry.path);
    check(isDeepStrictEqual(JSON.parse(onDisk), c), `Case contents differ from manifest artifact: ${entry.id}`);
    check(sha256(onDisk) === entry.sha256, `Case digest: ${entry.id}`);
    const source = [...manifest.sources, ...manifest.supplementalSources].find(s => s.path === c.source.path);
    check(source && source.revision === c.source.revision, `Unfrozen source: ${c.id}`);
    const [from, to] = c.source.lines;
    check(from <= to && to <= texts.get(c.source.path).split(/\r?\n/).length, `Source line range: ${c.id}`);
    check((c.kind === 'history' ? /^H/ : /^S/).test(c.id), `Case kind: ${c.id}`);
    check((c.regressions.length > 0) === (c.evidenceLevel === 'UNIT'), `Evidence level: ${c.id}`);
    for (const regression of c.regressions) {
      check(regression.testId === c.id, `Test ID: ${c.id}`);
      const test = await read(regression.testFile);
      const declaration = regression.status === 'OPEN' ? 'it.fails' : 'it';
      check(test.includes(`${declaration}('${regression.testName}'`), `Missing exact test/expected-failure marker: ${c.id}`);
      check((regression.status === 'PASS') === (c.status === 'FIXED'), `Regression status: ${c.id}`);
      check(regression.receipt === `.dsh-dev/deepening/b2/receipts/${c.id}.json`, 'Receipt path');
      if (receipts) await validateReceipt(c, regression);
    }
  }
  const caseIds = new Set(cases.map(c => c.id));
  unique(manifest.dispositions.map(d => d.candidateId), 'candidate disposition');
  check(manifest.dispositions.length === input.candidates.length, 'Candidate coverage mismatch');
  const candidateIds = new Set(input.candidates.map(c => c.id));
  for (const d of manifest.dispositions) {
    check(candidateIds.has(d.candidateId), `Unknown candidate: ${d.candidateId}`);
    if (d.disposition === 'out-of-scope') check(d.caseId === null && d.duplicateOf === null, 'Invalid exclusion destination');
    else {
      check(caseIds.has(d.caseId), `Unknown case: ${d.caseId}`);
      if (d.disposition === 'case') check(d.duplicateOf === null, 'Primary candidate has duplicate destination');
      else {
        const primary = manifest.dispositions.find(p => p.candidateId === d.duplicateOf);
        check(primary?.disposition === 'case' && primary.caseId === d.caseId, 'Dangling/cyclic/cross-case duplicate');
        check(d.candidateId !== d.duplicateOf, 'Self duplicate');
      }
    }
  }
  unique(manifest.openContracts, 'OPEN contract');
  check(isDeepStrictEqual([...manifest.openContracts].sort(), cases.filter(c => c.status === 'OPEN').map(c => c.id).sort()),
    'OPEN contract inventory mismatch');
  const history = cases.filter(c => c.kind === 'history');
  const shared = cases.filter(c => c.kind === 'shared');
  const executable = rows => rows.filter(c => c.regressions.length > 0).length;
  const fixed = history.filter(c => c.status === 'FIXED').length;
  check(history.length >= 12 && executable(history) >= 6 && fixed >= 6, 'History minimum coverage');
  check(shared.length >= 8 && executable(shared) >= 6, 'Shared minimum coverage');
  return { status: 'PASS', inventory, historyCases: history.length, distinctRootCauses: cases.length,
    historyReproductions: executable(history), fixedHistoryRegressions: fixed,
    sharedCases: shared.length, sharedReproductions: executable(shared),
    expectedFailures: cases.flatMap(c => c.regressions).filter(r => r.status === 'OPEN').length,
    openContracts: manifest.openContracts, runtimeReceiptsChecked: receipts,
    dispositions: Object.fromEntries(['case', 'duplicate', 'out-of-scope'].map(kind =>
      [kind, manifest.dispositions.filter(d => d.disposition === kind).length])) };
}
async function validateReceipt(c, regression) {
  const receipt = await readJson(regression.receipt);
  check(receipt.id === c.id && receipt.evidenceLevel === 'UNIT', `Receipt identity: ${c.id}`);
  check(receipt.status === regression.status && receipt.beforeFix?.status === 'FAIL', `Receipt verdict: ${c.id}`);
  check(!isDeepStrictEqual(receipt.beforeFix.observed, receipt.expected), `Missing actual failing observation: ${c.id}`);
  if (regression.status === 'PASS') {
    check(receipt.afterFix?.status === 'PASS' && isDeepStrictEqual(receipt.afterFix.observed, receipt.expected),
      `Missing repaired observation: ${c.id}`);
  } else check(receipt.afterFix?.status === 'NOT_RUN' && typeof receipt.assertion === 'string', `Hidden OPEN: ${c.id}`);
}
export async function main(args = process.argv.slice(2)) {
  check(args.every(arg => arg === '--receipts'), 'Usage: validate-cases.mjs [--receipts]');
  const summary = await validateBundle(await loadBundle(), { receipts: args.includes('--receipts') });
  await writeJson('.dsh-dev/deepening/b2/validation.json', summary);
  console.log(JSON.stringify(summary, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
