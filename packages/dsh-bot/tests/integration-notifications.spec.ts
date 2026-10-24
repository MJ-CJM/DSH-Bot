import { openIntegrationStores } from '../src/host/common/integration-stores.js';
import { need } from '../src/host/common/operations.js';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { randomUUID } from 'node:crypto';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { describe, expect, it, vi } from 'vitest';
import { quietAt, localTime, Notifications, type NotificationPort } from '../src/host/notifications/service.js';
import { registerNotifyTool } from '../src/host/notifications/tool.js';
import { notificationSchema } from '../src/shared/integrations.js';
import { alpha, beta, policy, withIntegrations } from './integration-support.js';
const port = () => ({ describe: vi.fn(async () => ({ targetDigest: 'fingerprint-one', label: 'Synthetic target' })), send: vi.fn<NotificationPort['send']>(async () => ({ state: 'accepted', platformMessageId: 'msg-one' })) });
const input = (operationId: string = randomUUID()) => ({ operationId, policyId: 'policy', text: 'Synthetic report' });
const source = { kind: 'tool' as const, id: 'source' };
describe('P34 persistent notification admission (real JSON domain; fake platform and controlled clock)', () => {
  it('preserves in-app notifications independently of external limits and never wakes a model', async () => withIntegrations(async f => {
    await f.notifications.savePolicy(policy('policy', 'in-app', { dailyLimit: 0, quietHours: { start: '00:00', end: '00:00' } }), 0, false);
    const r = await f.notifications.record(alpha, input('local'), source);
    expect((await f.notifications.deliver(r.id)).state).toBe('recorded');
    expect(f.notifications.list()).toHaveLength(1);
    expect((await f.notifications.markRead(r.id, f.notifications.get(r.id).revision)).readAt).toBe(f.clock.at);
    await expect(f.notifications.markRead(r.id, 1)).rejects.toMatchObject({ code: 'p34/conflict' });
    await expect(f.notifications.record(beta, input('wrong-owner'), source)).rejects.toMatchObject({ code: 'p34/not-found' });
  }));
  it('serializes quota reservations, deduplicates operationId and holds unknown quota across reopen', async () => {
    const p = port(); p.send.mockRejectedValue(new Error('disconnect AFTER send'));
    await withIntegrations(async f => {
      const saved = await f.notifications.savePolicy(policy('policy', 'im', { dailyLimit: 1 }), 0, false);
      const records = await Promise.all(['one', 'two'].map(id => f.notifications.record(alpha, input(id), source)));
      const results = await Promise.all(records.map(r => f.notifications.deliver(r.id, saved.scopeDigest)));
      expect(results.map(r => r.state).sort()).toEqual(['suppressed', 'unknown']); expect(p.send).toHaveBeenCalledOnce();
      expect(await f.notifications.record(alpha, input('one'), source)).toMatchObject({ id: 'one' });
      await f.notifications.deliver('one', saved.scopeDigest); expect(p.send).toHaveBeenCalledOnce();
      await expect(f.notifications.record(alpha, { ...input('one'), text: 'changed' }, source)).rejects.toMatchObject({ code: 'p34/conflict' });
      await f.notifications.close();
      const reopened = new Notifications(f.ctx, f.stores, f.registry, f.notifications.options, () => {}, p, () => f.clock.at);
      await reopened.recover(); await reopened.deliver('one', saved.scopeDigest); expect(p.send).toHaveBeenCalledOnce(); await reopened.close();
    }, p);
  });
  it('recovers sending as unknown and approval as cancelled, with no automatic resend', async () => {
    const p = port(); await withIntegrations(async f => {
      await f.notifications.savePolicy(policy(), 0, false);
      const one = await f.notifications.record(alpha, input('sending'), source); const two = await f.notifications.record(alpha, input('waiting'), source);
      await f.stores.notifications.table('intents').put(one.id, notificationSchema.parse({ ...one, state: 'sending', reservation: { at: f.clock.at, day: '2026-10-24' } }));
      await f.notifications.waiting(two.id);
      await f.notifications.close(); await f.connectors.close(); await f.stores.close();
      const stores = await openIntegrationStores(f.ctx); const n = new Notifications(f.ctx, stores, f.registry, f.notifications.options, () => {}, p, () => f.clock.at);
      await n.recover();
      expect(n.get(one.id)).toMatchObject({ state: 'unknown', reasonCode: 'recovery-needed' });
      expect(n.get(two.id).state).toBe('cancelled'); expect(p.send).not.toHaveBeenCalled();
      await n.close(); await stores.close();
    }, p);
  });
  it('rejects changed scope, fingerprint, Bot birthday and unconfirmed preapproval', async () => {
    const p = port(); await withIntegrations(async f => {
      await expect(f.notifications.savePolicy(policy('pre', 'im', { authorization: { mode: 'preapproved' } }), 0, false)).rejects.toMatchObject({ code: 'p34/approval-denied' });
      const saved = await f.notifications.savePolicy(policy(), 0, false); const one = await f.notifications.record(alpha, input('changed'), source);
      await f.notifications.savePolicy(policy('policy', 'im', { dailyLimit: 2 }), 1, false);
      expect((await f.notifications.deliver(one.id, saved.scopeDigest)).reasonCode).toBe('changed');
      const fresh = await f.notifications.record(alpha, input('fingerprint'), source);
      p.describe.mockResolvedValue({ targetDigest: 'replaced', label: 'Synthetic target' });
      expect((await f.notifications.deliver(fresh.id, fresh.scopeDigest)).reasonCode).toBe('changed');
      f.bots.set('alpha', { ...need(f.bots.get('alpha')), createdAt: 2 });
      await expect(f.notifications.record(alpha, input('stale'), source)).rejects.toMatchObject({ code: 'p34/conflict' }); expect(p.send).not.toHaveBeenCalled();
    }, p);
  });
  it('enforces cross-midnight local dates, DST transitions, exact quiet boundaries and clock rollback', async () => {
    const config = { timezone: 'America/Los_Angeles', quietHours: { start: '22:00', end: '07:00' } };
    expect(quietAt(Date.parse('2026-10-24T05:00:00Z'), config)).toBe(true);
    expect(quietAt(Date.parse('2026-10-24T14:00:00Z'), config)).toBe(false);
    expect(quietAt(Date.parse('2026-10-24T04:59:59Z'), config)).toBe(false);
    expect(quietAt(Date.now(), { ...config, quietHours: { start: '00:00', end: '00:00' } })).toBe(true);
    for (const at of ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z']) expect(localTime(Date.parse(at), config.timezone)).toEqual({ day: '2026-11-01', time: '01:30' });
    expect(localTime(Date.parse('2026-03-08T10:00:00Z'), config.timezone).time).toBe('03:00');
    const p = port(); await withIntegrations(async f => {
      f.clock.at = Date.parse('2026-10-24T06:59:00Z');
      const saved = await f.notifications.savePolicy(policy('policy', 'im', { dailyLimit: 1, timezone: config.timezone }), 0, false);
      for (const [id, offset] of [['before', 0], ['after', 60000], ['over', 0]] as const) {
        f.clock.at += offset; const r = await f.notifications.record(alpha, input(id), source); await f.notifications.deliver(r.id, saved.scopeDigest);
      }
      expect(f.notifications.get('before').state).toBe('accepted'); expect(f.notifications.get('after').state).toBe('accepted'); expect(f.notifications.get('over').reasonCode).toBe('daily-limit');
      f.clock.at -= 120000; const r = await f.notifications.record(alpha, input('rollback'), source); expect((await f.notifications.deliver(r.id, saved.scopeDigest)).reasonCode).toBe('daily-limit');
    }, p);
  });
  it('uses cooldown reservations including failed sends and keeps dedup tombstones after content retention', async () => {
    const p = port(); p.send.mockResolvedValue({ state: 'failed' }); await withIntegrations(async f => {
      const saved = await f.notifications.savePolicy(policy('policy', 'im', { cooldownSec: 60 }), 0, false);
      for (const id of ['first', 'cool']) { const r = await f.notifications.record(alpha, input(id), source); await f.notifications.deliver(r.id, saved.scopeDigest); }
      expect(f.notifications.get('cool').reasonCode).toBe('cooldown');
      f.clock.at += 61_000; const r = await f.notifications.record(alpha, input('later'), source); expect((await f.notifications.deliver(r.id, saved.scopeDigest)).state).toBe('failed');
      f.clock.at += 31 * 86400000; await f.notifications.record(alpha, input('prune'), source);
      await expect(f.notifications.record(alpha, input('first'), source)).rejects.toMatchObject({ code: 'p34/recovery-needed' });
    }, p);
  });
  it('bounds a stuck platform send, records unknown and keeps the reservation', async () => {
    const p = port(); p.send.mockImplementation(async request => new Promise((_accept, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    await withIntegrations(async f => {
      const saved = await f.notifications.savePolicy(policy('policy', 'im', { dailyLimit: 1 }), 0, false);
      const r = await f.notifications.record(alpha, input('timeout'), source);
      expect((await f.notifications.deliver(r.id, saved.scopeDigest)).state).toBe('unknown');
      const next = await f.notifications.record(alpha, input('after-timeout'), source);
      expect((await f.notifications.deliver(next.id, saved.scopeDigest)).reasonCode).toBe('daily-limit');
      expect(p.send).toHaveBeenCalledOnce();
    }, p);
  });
  it('Host shutdown cancels an in-flight adapter call without sending a second attempt', async () => {
    const p = port(); p.send.mockImplementation(async request => new Promise((_accept, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    await withIntegrations(async f => {
      const saved = await f.notifications.savePolicy(policy(), 0, false); const r = await f.notifications.record(alpha, input('close'), source);
      const request = f.notifications.deliver(r.id, saved.scopeDigest); await vi.waitFor(() => expect(p.send).toHaveBeenCalledOnce());
      await f.notifications.close(); expect((await request).state).toBe('unknown');
      await expect(f.notifications.record(alpha, input('late'), source)).rejects.toMatchObject({ code: 'p34/unavailable' });
    }, p);
  });
  it('refuses IM without adapter while local policies remain usable', async () => withIntegrations(async f => {
    await expect(f.notifications.savePolicy(policy(), 0, false)).rejects.toMatchObject({ code: 'p34/unsupported' });
    expect((await f.notifications.savePolicy(policy('policy', 'im', { enabled: false }), 0, false)).enabled).toBe(false);
    expect(f.notifications.supported()).toBe(false);
  }));
});
describe('bot_notify with real native ToolRuntime and ApprovalService, Agent event fixture', () => {
  async function execute(f: Parameters<Parameters<typeof withIntegrations>[0]>[0], agent: ReturnType<typeof f.createAgent>['agent'], id = randomUUID()) {
    return f.ctx.tools.execute({ agent, name: 'bot_notify', arguments: { policyId: 'policy', text: 'Specific text' }, callId: ToolCallId(id), signal: new AbortController().signal });
  }
  it('denied native ask sends nothing, leaves local cancelled record and bilingual approval audit', async () => {
    const p = port(); await withIntegrations(async f => {
      await f.notifications.savePolicy(policy(), 0, false); const a = f.createAgent(); registerNotifyTool(a.agent, alpha, f.notifications);
      const approval: unknown[] = []; f.ctx.on('approval/request', async request => { approval.push(request.displayReason); return 'rejected'; });
      expect((await execute(f, a.agent)).isError).toBe(true);
      await vi.waitFor(() => expect(f.notifications.list()[0]?.state).toBe('cancelled'));
      expect(p.send).not.toHaveBeenCalled(); expect(JSON.stringify(approval)).toContain('Specific text'); expect(JSON.stringify(approval)).toContain('授权范围');
      expect(a.agent.session.snapshotEvents().filter(e => e.type.startsWith('approval/'))).toHaveLength(2);
    }, p);
  });
  it('allows approved call exactly once and rejects a policy edit during approval', async () => {
    const p = port(); await withIntegrations(async f => {
      await f.notifications.savePolicy(policy(), 0, false); const a = f.createAgent(); registerNotifyTool(a.agent, alpha, f.notifications);
      f.ctx.on('approval/request', async () => 'allowed-once');
      const callId = randomUUID(); expect((await execute(f, a.agent, callId)).isError).toBe(false); await execute(f, a.agent, callId); expect(p.send).toHaveBeenCalledOnce();
      const off = f.ctx.on('approval/request', async () => { await f.notifications.savePolicy(policy('policy', 'im', { dailyLimit: 2 }), 1, false); return 'allowed-once'; }, { prepend: true });
      await execute(f, a.agent); off(); expect(f.notifications.list().some(r => r.reasonCode === 'changed')).toBe(true); expect(p.send).toHaveBeenCalledOnce();
    }, p);
  });
  it('native never policy refuses ask on a subagent without borrowing a root session', async () => {
    const p = port(); await withIntegrations(async f => {
      await f.notifications.savePolicy(policy(), 0, false); const a = f.createAgent('native-never-child'); registerNotifyTool(a.agent, alpha, f.notifications);
      setApprovalPolicy(a.agent.session, 'never');
      expect((await execute(f, a.agent)).isError).toBe(true); expect(p.send).not.toHaveBeenCalled();
    }, p);
  });
});