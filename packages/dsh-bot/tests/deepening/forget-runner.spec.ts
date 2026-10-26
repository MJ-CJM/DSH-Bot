import { describe, expect, it, vi } from 'vitest';
import { ForgetPreviews } from '../../src/host/memory/forget-preview.js';
import { ForgetRunner, type ForgetIO } from '../../src/host/memory/forget-runner.js';
import { v2Fixture } from './v2-fixtures.js';
const inventory = async () => ({ sessionIds: ['alpha-session'], historyNodes: 1, summaries: 0,
  copies: 3, pendingMessages: 0, conservative: false, rootInstructions: false, stamp: 1 });
const io = (): ForgetIO => ({ drain: vi.fn(async () => {}), history: vi.fn(async () => []),
  copies: vi.fn(async () => {}), verifyInventory: vi.fn(async () => []) });
describe('I18 durable two-level forgetting with explicit audited test seams', () => {
  it('stop choice commits a tombstone, excludes payloads, and never claims strong verification', async () => {
    const f = await v2Fixture();
    try {
      const row = await f.alpha.save({ content: 'SYNTHETIC_ERASE_ME' });
      const version = f.kernel.snapshot.versions.get(row.id);
      if (!version) throw new Error('Missing version');
      await f.kernel.domain.table('migration_items').put('SYNTHETIC_OLD_ID', {
        legacyId: 'SYNTHETIC_OLD_ID', memoryId: row.id, versionId: version.versionId,
        contentRef: version.contentRef, opId: row.id, quarantine: false,
      });
      const previews = new ForgetPreviews(f.kernel, inventory), deps = io();
      const runner = new ForgetRunner(f.kernel, previews, deps);
      const preview = await previews.create({ memoryId: row.id, mode: 'related' });
      const result = await runner.choose({ previewRevision: preview.previewRevision, choice: 'stop' });
      expect(result).toMatchObject({ stopped: true, strong: false, phase: 'stopped' });
      expect(deps.history).not.toHaveBeenCalled(); expect(f.kernel.blocked).toBe(true);
      expect(f.kernel.domain.table('payloads').size).toBe(0);
      expect(f.kernel.domain.table('migration_items').size).toBe(0);
      expect(JSON.stringify([...f.kernel.domain.table('forget_jobs').entries()])).not.toContain('SYNTHETIC_ERASE_ME');
      const reopened = await f.reopen();
      expect(f.kernel.blocked).toBe(true); expect(await reopened.alpha.list({})).toEqual([]);
      expect(f.kernel.snapshot.forgotten.has(row.id)).toBe(true);
    } finally { await f.close(); }
  });
  it('keeps unreachable copies blocked through cold recovery; retry is idempotent after verification', async () => {
    const f = await v2Fixture();
    try {
      const row = await f.alpha.save({ content: 'COPY_CANARY' });
      const previews = new ForgetPreviews(f.kernel, inventory), deps = io();
      deps.copies = vi.fn(async () => { throw new Error('offline'); });
      const runner = new ForgetRunner(f.kernel, previews, deps);
      const p = await previews.create({ memoryId: row.id, mode: 'version' });
      const blocked = await runner.choose({ previewRevision: p.previewRevision, choice: 'clean' });
      expect(blocked).toMatchObject({ stopped: true, strong: false, phase: 'blocked', reasons: ['copies'] });
      await runner.close(); await f.reopen();
      const healthy = io(), cold = new ForgetRunner(f.kernel, new ForgetPreviews(f.kernel, inventory), healthy);
      await cold.recover();
      expect(cold.status(blocked.id).strong).toBe(true); expect(f.kernel.blocked).toBe(false);
      const count = f.kernel.domain.table('receipts').size;
      await cold.resume(blocked.id); await cold.recover();
      expect(f.kernel.domain.table('receipts').size).toBe(count);
      expect(healthy.copies).toHaveBeenCalledTimes(1);
      expect(f.kernel.domain.table('payloads').size).toBe(0);
    } finally { await f.close(); }
  });
  it('does not release after a failed barrier write and reconciles the same receipt on reopen', async () => {
    const f = await v2Fixture();
    try {
      const row = await f.alpha.save({ content: 'SAFE_TEST' });
      const previews = new ForgetPreviews(f.kernel, inventory), runner = new ForgetRunner(f.kernel, previews, io());
      const p = await previews.create({ memoryId: row.id, mode: 'version' });
      const table = f.kernel.domain.table('barriers'), put = table.put.bind(table);
      const spy = vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
        if (value.state === 'verified') throw new Error('synthetic barrier write failure');
        await put(key, value);
      });
      await expect(runner.choose({ previewRevision: p.previewRevision, choice: 'clean' })).rejects.toThrow('barrier write failure');
      expect(f.kernel.blocked).toBe(true); spy.mockRestore(); await f.reopen();
      const cold = new ForgetRunner(f.kernel, new ForgetPreviews(f.kernel, inventory), io());
      await cold.recover(); expect(f.kernel.blocked).toBe(false);
      expect(cold.statuses()[0]?.strong).toBe(true);
    } finally { await f.close(); }
  });
  it('retains the durable Inbox dependency even when a reopened native queue appears empty', async () => {
    const f = await v2Fixture();
    try {
      const row = await f.alpha.save({ content: 'PENDING_INBOX_TARGET' });
      const previews = new ForgetPreviews(f.kernel, async () => ({ ...await inventory(), pendingMessages: 1 }));
      const runner = new ForgetRunner(f.kernel, previews, io());
      const p = await previews.create({ memoryId: row.id, mode: 'version' });
      const stopped = await runner.choose({ previewRevision: p.previewRevision, choice: 'clean' });
      expect(stopped).toMatchObject({ strong: false, phase: 'blocked', reasons: ['inbox'] });
      await runner.close(); await f.reopen();
      const cold = new ForgetRunner(f.kernel, new ForgetPreviews(f.kernel, inventory), io());
      await cold.recover();
      expect(cold.status(stopped.id)).toMatchObject({ strong: false, phase: 'blocked', reasons: ['inbox'] });
      expect(f.kernel.blocked).toBe(true);
    } finally { await f.close(); }
  });
  it('retains system-head/raw-read/inventory reasons and leaves strong false', async () => {
    const f = await v2Fixture();
    try {
      const row = await f.alpha.save({ content: 'SYSTEM_CANARY' });
      const previews = new ForgetPreviews(f.kernel, inventory), deps = io();
      deps.history = async () => ['system-head', 'raw-read-policy']; deps.verifyInventory = async () => ['inventory'];
      const runner = new ForgetRunner(f.kernel, previews, deps), p = await previews.create({ memoryId: row.id, mode: 'version' });
      const result = await runner.choose({ previewRevision: p.previewRevision, choice: 'clean' });
      expect(result.strong).toBe(false); expect(result.reasons).toEqual(['system-head', 'raw-read-policy', 'inventory', 'history']);
      expect(f.kernel.blocked).toBe(true);
    } finally { await f.close(); }
  });
});
