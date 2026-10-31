import { Serial } from '../common/operations.js';
import { addUsage, ceiling, charge, ledgerSchema, reservationInputSchema, usageSchema, within, zeroUsage } from '../../shared/eval-budget.js';
import type { LedgerState, ReservationInput, Usage } from '../../shared/eval-budget.js';

/** One owner/queue per ledger. Persistence must commit before admission; ambiguous writes freeze this instance. */
export class BudgetLedger {
  private queue = new Serial();
  private frozen = false;
  private constructor(private state: LedgerState, private persist: (state: LedgerState) => Promise<void>) {}
  static async open(initial: LedgerState, persist: (state: LedgerState) => Promise<void>) {
    const state = ledgerSchema.parse(initial);
    if (state.blocked) throw Error('Ledger blocked; manual reconciliation required');
    if (new Set(state.reservations.map(row => row.id)).size !== state.reservations.length) throw Error('Duplicate reservation');
    for (const row of state.reservations) {
      const needed = charge(state.price, row.calls, row.inputCeiling, row.outputCeiling);
      if (row.priceVersion !== state.price.version || row.model !== state.price.model || !within(needed, ceiling(row)))
        throw Error('Invalid reservation price');
      if (row.actual && (!within(row.actual, ceiling(row)) ||
        row.actual.money !== charge(state.price, row.actual.calls, row.actual.input, row.actual.output).money)) throw Error('Invalid actual');
      if (row.state === 'reserved') row.state = 'unknown';
    }
    const ledger = new BudgetLedger(state, persist);
    if (!within(ledger.liability(), state.limits)) throw Error('Invalid ledger liability');
    await persist(structuredClone(state));
    return ledger;
  }
  snapshot() { return structuredClone(this.state); }
  liability(): Usage {
    return this.state.reservations.reduce((total, row) => addUsage(total, row.actual ?? ceiling(row)), zeroUsage());
  }
  private async commit(next: LedgerState) {
    if (this.frozen) throw Error('Ledger frozen; reopen to reconcile');
    try { await this.persist(ledgerSchema.parse(next)); }
    catch (error) { this.frozen = true; throw error; }
    this.state = next;
  }
  reserve(input: ReservationInput) {
    return this.queue.run(async () => {
      if (this.frozen) throw Error('Ledger frozen');
      const request = reservationInputSchema.parse(input), price = this.state.price;
      const previous = this.state.reservations.find(row => row.id === request.id);
      if (previous) {
        const { state: _, actual: __, ...identity } = previous;
        if (JSON.stringify(identity) !== JSON.stringify(request)) throw Error('Reservation ID reused');
        // An ID is idempotent accounting, never permission to execute a second time.
        return { admitted: false, reservation: structuredClone(previous) };
      }
      if (request.priceVersion !== price.version || request.model !== price.model) throw Error('Missing matching price');
      if (!within(charge(price, request.calls, request.inputCeiling, request.outputCeiling), ceiling(request)))
        throw Error('Missing cost upper bound');
      if (!within(addUsage(this.liability(), ceiling(request)), this.state.limits)) throw Error('Budget exceeded');
      const reservation = { ...request, state: 'reserved' as const };
      await this.commit({ ...this.state, reservations: [...this.state.reservations, reservation] });
      return { admitted: true, reservation: structuredClone(reservation) };
    });
  }
  settle(id: string, value: Usage | null) {
    return this.queue.run(async () => {
      if (this.frozen) throw Error('Ledger frozen');
      const next = this.snapshot(), row = next.reservations.find(row => row.id === id);
      if (!row) throw Error('Unknown reservation');
      if (value === null) {
        if (row.state === 'settled') throw Error('Already settled');
        row.state = 'unknown';
      } else {
        const actual = usageSchema.parse(value);
        if (row.state === 'unknown') throw Error('Unknown liability needs external reconciliation');
        if (!within(actual, ceiling(row)) || actual.money !== charge(next.price, actual.calls, actual.input, actual.output).money) {
          next.blocked = true; await this.commit(next); this.frozen = true;
          throw Error('Actual exceeds bound or price mismatch; ledger blocked');
        }
        if (row.state === 'settled') {
          if (JSON.stringify(row.actual) !== JSON.stringify(actual)) throw Error('Settlement changed');
          return structuredClone(row);
        }
        row.actual = actual; row.state = 'settled';
      }
      await this.commit(next);
      return structuredClone(row);
    });
  }
  async close() { await this.queue.close(); }
}
