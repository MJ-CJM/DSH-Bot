import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The command modules are ESM tooling, outside the product TypeScript compilation boundary.
const url = pathToFileURL(resolve('../../scripts/deepening/validate-cases.mjs')).href;
const { loadBundle, schemas, validateBundle } = await import(url);

describe('M1 failure catalog validates frozen coverage, schema and OPEN inventory', () => {
  it('accepts the complete frozen catalog without implying runtime receipt validation', async () => {
    const summary = await validateBundle();
    expect(summary.inventory.sources).toBe(46);
    expect(summary.inventory.candidates).toBe(310);
    expect(summary.historyCases).toBeGreaterThanOrEqual(12);
    expect(summary.fixedHistoryRegressions).toBe(7);
    expect(summary.sharedReproductions).toBe(6);
    expect(summary.expectedFailures).toBe(3);
    expect(summary.runtimeReceiptsChecked).toBe(false);
  });

  it('rejects unknown case fields, missing evidence, illegal levels and invalid source ranges', async () => {
    const schema = await schemas();
    const { cases } = await loadBundle();
    const first = cases[0];
    expect(schema.case.safeParse({ ...first, unreviewed: true }).success).toBe(false);
    const missing = { ...first };
    delete missing.evidenceLevel;
    expect(schema.case.safeParse(missing).success).toBe(false);
    expect(schema.case.safeParse({ ...first, evidenceLevel: 'PASS' }).success).toBe(false);
    expect(schema.case.safeParse({ ...first, source: { ...first.source, lines: [0, 1] } }).success).toBe(false);
  });

  it('rejects manifest shape changes before checking cross references', async () => {
    const schema = await schemas();
    const { manifest } = await loadBundle();
    expect(schema.manifest.safeParse({ ...manifest, unexpected: true }).success).toBe(false);
    expect(schema.manifest.safeParse({ ...manifest, actualCandidates: 1.5 }).success).toBe(false);
  });

  it('rejects a missing candidate disposition', async () => {
    const bundle = await loadBundle();
    bundle.manifest.dispositions.pop();
    await expect(validateBundle(bundle)).rejects.toThrow('coverage');
  });

  it('rejects duplicate candidate destinations even if the total count is unchanged', async () => {
    const bundle = await loadBundle();
    bundle.manifest.dispositions[1] = structuredClone(bundle.manifest.dispositions[0]);
    await expect(validateBundle(bundle)).rejects.toThrow('Duplicate candidate');
  });

  it('rejects dangling or cyclic duplicate links', async () => {
    const bundle = await loadBundle();
    const duplicate = bundle.manifest.dispositions.find((d: { disposition: string }) => d.disposition === 'duplicate');
    duplicate.duplicateOf = duplicate.candidateId;
    await expect(validateBundle(bundle)).rejects.toThrow('duplicate');
  });

  it('rejects an exclusion that also points to a case', async () => {
    const bundle = await loadBundle();
    const excluded = bundle.manifest.dispositions.find((d: { disposition: string }) => d.disposition === 'out-of-scope');
    excluded.caseId = 'H01';
    await expect(validateBundle(bundle)).rejects.toThrow('Invalid exclusion');
  });

  it('rejects stale hashes and hiding an OPEN requirement', async () => {
    const bundle = await loadBundle();
    bundle.manifest.inputSha256 = '0'.repeat(64);
    await expect(validateBundle(bundle)).rejects.toThrow('digest');
    const other = await loadBundle();
    other.manifest.openContracts.pop();
    await expect(validateBundle(other)).rejects.toThrow('OPEN contract');
  });

  it('rejects changes to a case artifact rather than trusting the supplied clone', async () => {
    const bundle = await loadBundle();
    bundle.cases[0].source.lines = [999999, 999999];
    await expect(validateBundle(bundle)).rejects.toThrow('contents differ');
  });
});
