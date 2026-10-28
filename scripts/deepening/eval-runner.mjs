import { mkdir, open, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mock } from '../../evals/adapters/mock.ts';
import { replay } from '../../evals/adapters/replay.ts';
import { score, aggregate } from '../../evals/scorers/index.ts';
import { BudgetLedger } from '../../packages/dsh-bot/lib/host/shadow/budget.js';
import { charge } from '../../packages/dsh-bot/lib/shared/eval-budget.js';
import { loadEvaluation } from './eval-input.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
export async function durableJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`, handle = await open(temp, 'wx');
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
export async function runEvaluation(mode, counters) {
  if (!['mock', 'replay'].includes(mode)) throw Error('Real evaluation disabled');
  const { manifest, cases, responses } = await loadEvaluation();
  const runId = `b8-eval-${mode}-${Date.now()}-${randomUUID()}`;
  const dir = resolve(root, '.dsh-dev/deepening', runId); await mkdir(dir, { recursive: true });
  await durableJson(resolve(dir, 'manifest.json'), { ...manifest, mode });
  const ledger = await BudgetLedger.open({ version: 1, limits: manifest.limits, price: manifest.priceSnapshot, reservations: [] },
    state => durableJson(resolve(dir, 'ledger.json'), state));
  const rows = [];
  try {
    for (const item of cases) {
      // Synthetic token units are deterministic UTF-8 bytes/4, never billed provider token measurements.
      const inputUnits = Math.ceil(Buffer.byteLength(JSON.stringify(item.input)) / 4);
      const outputBound = manifest.outputCeiling;
      const reservation = { id: `${runId}:${item.id}:1`, runId, caseId: item.id, attempt: 1, model: 'synthetic',
        priceVersion: manifest.priceSnapshot.version, calls: 1, inputCeiling: inputUnits, outputCeiling: outputBound,
        moneyCeiling: charge(manifest.priceSnapshot, 1, inputUnits, outputBound).money };
      let response = { status: 'error' }, admitted = false;
      try {
        admitted = (await ledger.reserve(reservation)).admitted;
        if (!admitted) throw Error('Duplicate execution denied');
        response = mode === 'mock' ? mock({ kind: item.kind, input: item.input }) : replay(item.id, responses);
        if (response.status === 'timeout') await ledger.settle(reservation.id, null);
        else await ledger.settle(reservation.id,
          charge(manifest.priceSnapshot, 1, inputUnits, Math.ceil(Buffer.byteLength(JSON.stringify(response)) / 4)));
      } catch (error) {
        // Failed admission/adapter/settlement remains in the fixed denominator, with its reservation retained.
        if (admitted) await ledger.settle(reservation.id, null).catch(() => {});
        response = { status: 'error', error: String(error) };
      }
      rows.push({ item, response, admitted, result: score(item, response) });
    }
    const summary = { status: 'PASS', watermark: `${mode.toUpperCase()} / SYNTHETIC / NOT REAL MODEL QUALITY`,
      dir, seed: manifest.seed, metrics: aggregate(rows), cost: { liability: ledger.liability(), realMoney: 'N/A' },
      accounting: { admitted: rows.filter(row => row.admitted).length, reservations: ledger.snapshot().reservations.length },
      io: counters, realModelRequests: 0, realShadowQuality: 'FAIL (NOT_RUN)' };
    await durableJson(resolve(dir, 'results.json'), rows);
    await durableJson(resolve(dir, 'summary.json'), summary);
    return summary;
  } finally { await ledger.close(); }
}
