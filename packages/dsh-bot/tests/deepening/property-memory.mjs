import assert from 'node:assert/strict';
import { createInput, erase, replayEqual } from './property-runtime.mjs';

export function memoryCommand(action, slot) {
  return { check: () => true, toString: () => `memory(${action},${slot})`, async run(model, real) {
    const runtime = real.runtime, kernel = runtime.kernel, m = runtime.manage();
    const entry = model.rows.get(slot), botId = slot % 2 ? 'beta' : 'alpha';
    const content = `SYNTHETIC_SLOT_${slot}_STEP_${model.steps}`;
    if (action === 0) {
      const from = model.at + slot * 1000, valid = slot % 3 ? { from, to: from + 3600000, basis: 'explicit' }
        : { from: null, to: null, basis: 'unknown' };
      const id = await m.create({ ...createInput(runtime, content, 'private', botId), valid });
      const row = { id, content, scope: 'private', botId, valid };
      model.rows.set(slot, row); model.all.set(id, row); model.writes++;
    } else if (action === 1 && entry) {
      await m.revise({ id: entry.id, expectedRevision: kernel.seq, patch: { content } });
      entry.content = content; model.writes++;
    } else if (action === 2 && entry) {
      const id = await m.confirm({ id: entry.id, botId: entry.botId, scope: 'shared', expectedRevision: kernel.seq });
      if (id !== entry.id) model.rows.set(slot + 8, { ...entry });
      const row = { ...entry, id, scope: 'shared' };
      model.rows.set(slot, row); model.all.set(id, row); model.confirms++;
    } else if (action === 3 && entry) {
      await erase(runtime, entry.id); model.forgotten.add(entry.id);
      for (const [key, row] of model.rows) if (row.id === entry.id) model.rows.delete(key);
      model.all.delete(entry.id);
    } else if (action === 4) {
      const seq = kernel.seq;
      await assert.rejects(m.create({ ...createInput(runtime, content), expectedRevision: seq + 1 }));
      assert.equal(kernel.seq, seq);
    } else if (action === 5) { await runtime.reopen(); model.reopens++; }
    else if (action === 6) replayEqual(kernel);
    else if (action === 7) model.at = Math.max(0, model.at + (slot % 2 ? 86400000 : -3600000));
    else if (action === 8) {
      const controller = new AbortController(), seq = kernel.seq; controller.abort();
      await assert.rejects(runtime.privateStore().saveUnique({ botId, content }, controller.signal));
      assert.equal(kernel.seq, seq); model.cancellations++;
    }
    model.steps++;
    const current = runtime.kernel;
    for (const id of model.forgotten) assert.equal(current.snapshot.versions.has(id), false);
    for (const row of model.all.values()) {
      const v = current.snapshot.versions.get(row.id); assert.ok(v);
      assert.equal(current.domain.table('payloads').get(v.contentRef).content, row.content);
      if (v.scope === 'private') assert.equal(v.ownerBotKey.botId, row.botId);
    }
    if (model.steps % 20 === 0) {
      replayEqual(current);
      for (const id of ['alpha', 'beta']) {
        const view = runtime.manage().query({ botId: id, scope: 'private', view: 'all', at: model.at, limit: 200 });
        assert.ok(view.rows.every(row => row.version.ownerBotKey.botId === id));
        for (const scope of ['private', 'shared']) {
          const actual = runtime.manage().query({ botId: id, scope, view: 'facts', at: model.at, limit: 200 });
          const expected = [...model.all.values()].filter(row => row.scope === scope && (scope === 'shared' || row.botId === id) &&
            (row.valid.from === null || row.valid.from <= model.at) && (row.valid.to === null || model.at < row.valid.to));
          assert.deepEqual(new Set(actual.rows.map(row => row.version.memoryId)), new Set(expected.map(row => row.id)));
        }
      }
    }
  } };
}
export const memoryModel = () => ({ rows: new Map(), all: new Map(), forgotten: new Set(), at: 100000000,
  steps: 0, writes: 0, confirms: 0, reopens: 0, cancellations: 0 });
