import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BudgetLedger } from '../../src/host/shadow/budget.js';
import { charge, type LedgerState, type ReservationInput } from '../../src/shared/eval-budget.js';
const price = { version: 'p1', source: 'synthetic' as const, model: 'synthetic', call: 10, input: 1, output: 2 };
const initial = (): LedgerState => ({ version: 1, limits: { calls: 2, input: 20, output: 20, money: 100 }, price, reservations: [] });
const input = (id: string): ReservationInput => ({ id, runId: 'run', caseId: id, attempt: 1, model: price.model,
  priceVersion: price.version, calls: 1, inputCeiling: 10, outputCeiling: 10, moneyCeiling: 40 });
describe('I63 conservative offline budget admission', () => {
  it('serializes competing reservations and persists before returning permission', async () => {
    let disk = initial();
    const ledger = await BudgetLedger.open(disk, async state => { disk = structuredClone(state); });
    try {
      const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => ledger.reserve(input(`${i}`))));
      expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(2);
      expect(disk.reservations).toHaveLength(2); expect(ledger.liability().calls).toBe(2);
      expect(await ledger.reserve(input('0'))).toMatchObject({ admitted: false });
      await expect(ledger.reserve({ ...input('0'), attempt: 2 })).rejects.toThrow('reused');
    } finally { await ledger.close(); }
    await expect(ledger.reserve(input('late'))).rejects.toThrow();
  });
  it('releases only settled differences; accounts failed calls and repeated settlements exactly once', async () => {
    const ledger = await BudgetLedger.open(initial(), async () => {});
    try {
      await ledger.reserve(input('failed')); const actual = charge(price, 1, 4, 0);
      await ledger.settle('failed', actual); await ledger.settle('failed', actual);
      expect(ledger.liability()).toEqual(actual);
      await expect(ledger.settle('failed', charge(price, 1, 5, 0))).rejects.toThrow('changed');
      await ledger.reserve(input('retry'));
      expect(ledger.liability().calls).toBe(2);
      await expect(ledger.reserve(input('third'))).rejects.toThrow('Budget');
    } finally { await ledger.close(); }
  });
  it('retains timeout liability and refuses to automatically refund an unknown attempt', async () => {
    const ledger = await BudgetLedger.open(initial(), async () => {});
    try {
      await ledger.reserve(input('timeout')); await ledger.settle('timeout', null);
      expect(ledger.liability()).toEqual({ calls: 1, input: 10, output: 10, money: 40 });
      await expect(ledger.settle('timeout', charge(price, 0, 0, 0))).rejects.toThrow('reconciliation');
    } finally { await ledger.close(); }
  });
  it('reopens an on-disk reservation as unknown, preserves limits, and never grants duplicate execution', async () => {
    const base = resolve('../../.dsh-dev/deepening'); await mkdir(base, { recursive: true });
    const dir = await mkdtemp(resolve(base, 'b8-ledger-')), path = resolve(dir, 'ledger.json');
    const persist = async (state: LedgerState) => { await writeFile(path, JSON.stringify(state)); };
    try {
      const hot = await BudgetLedger.open(initial(), persist); await hot.reserve(input('crashed')); await hot.close();
      const cold = await BudgetLedger.open(JSON.parse(await readFile(path, 'utf8')), persist);
      expect(cold.snapshot().reservations[0]?.state).toBe('unknown');
      expect((await cold.reserve(input('crashed'))).admitted).toBe(false);
      await cold.reserve(input('retry')); await expect(cold.reserve(input('third'))).rejects.toThrow('Budget');
      await cold.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects missing price/bounds, unsafe arithmetic, corrupt liabilities and over-ceiling measurements', async () => {
    const ledger = await BudgetLedger.open(initial(), async () => {});
    try {
      await expect(ledger.reserve({ ...input('bad-price'), priceVersion: 'unknown' })).rejects.toThrow('price');
      await expect(ledger.reserve({ ...input('bad-bound'), moneyCeiling: 0 })).rejects.toThrow('upper bound');
      await expect(ledger.reserve({ ...input('missing'), outputCeiling: undefined } as unknown as ReservationInput)).rejects.toThrow();
      await expect(ledger.reserve({ ...input('overflow'), inputCeiling: Number.MAX_SAFE_INTEGER })).rejects.toThrow();
      await ledger.reserve(input('valid'));
      await expect(ledger.settle('valid', charge(price, 1, 11, 0))).rejects.toThrow('bound');
      await expect(ledger.settle('valid', { calls: 1, input: 0, output: 0, money: 0 })).rejects.toThrow('frozen');
      await expect(BudgetLedger.open(ledger.snapshot(), async () => {})).rejects.toThrow('blocked');
    } finally { await ledger.close(); }
    await expect(BudgetLedger.open({ ...initial(), limits: { calls: -1, input: 0, output: 0, money: 0 } }, async () => {}))
      .rejects.toThrow();
  });
  it('freezes after an ambiguous commit and recovers the durable reservation as unknown', async () => {
    let disk = initial(), fail = false;
    const ledger = await BudgetLedger.open(disk, async state => { disk = structuredClone(state); if (fail) throw Error('fsync unknown'); });
    fail = true; await expect(ledger.reserve(input('a'))).rejects.toThrow('fsync');
    await expect(ledger.reserve(input('b'))).rejects.toThrow('frozen'); await ledger.close();
    const cold = await BudgetLedger.open(disk, async () => {});
    expect(cold.snapshot().reservations[0]?.state).toBe('unknown'); expect(cold.liability().calls).toBe(1); await cold.close();
  });
});
