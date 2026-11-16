import { expect, it, vi } from 'vitest';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent';
import { FollowUpEvents } from '../src/host/proactive/follow-up-events.js';
import { alpha, withIntegrations } from './integration-support.js';
import { proactiveWorker } from './proactive-worker-fixture.js';
import type { FollowUpIngest } from '../src/shared/proactive/follow-up.js';

it('owns main-scoped native callbacks, reads durable end after residency disappears and removes every listener', async () => {
  const core = await proactiveWorker();
  try {
    await withIntegrations(async f => {
      const mainId = SessionId('scope-main'), childId = SessionId('scope-child'), key = {};
      const main = Session.create(mainId, undefined, { version: 4, id: mainId, createdAt: 1, isSeeded: false });
      const child = Session.create(childId, undefined, { version: 4, id: childId, createdAt: Date.now(), isSeeded: false,
        parentSession: mainId, origin: 'subagent' });
      const owner = createScope(f.ctx, key), agent = { id: mainId, session: main, ctx: owner.ctx } as Agent;
      let resident = true;
      const logs = new Map([[mainId, main], [childId, child]]), reads = vi.fn();
      Object.assign(f.registry, { mainSessions: { boundSessionId: () => mainId }, directorySnapshot: () => [] });
      f.ctx.provide('agents', { get: (id: SessionId) => id === mainId ? agent : undefined } as unknown as Context['agents']);
      f.ctx.provide('sessions', { get: (id: SessionId) => id === mainId ? main : resident ? child : undefined,
        flush: async () => true } as unknown as Context['sessions']);
      const runtime = {} as Context['subagents']; f.ctx.provide('subagents', runtime);
      const stats = vi.fn(async (id: SessionId) => {
        const log = logs.get(id); return log && { header: log.header };
      });
      f.ctx.provide('sessionPersistence', { stat: stats, open: async (id: SessionId) => {
        const log = logs.get(id); if (!log) throw new Error('No log');
        return { header: log.header, inheritedEventCount: 0,
          read: async (offset: number, length: number) => { reads(id); return { events: log.snapshotEvents().slice(offset, offset + length) }; },
          close: async () => {} };
      } } as unknown as Context['sessionPersistence']);
      f.ctx.provide('dshBotProactive', { read: core.read, change: core.change,
        ingestFollowUp: (id: string, input: FollowUpIngest) => core.change(id, { kind: 'follow-up-ingest', input }) } as unknown as Context['dshBotProactive']);
      const subject = { kind: 'bot', bot: alpha } as const;
      await core.submit({ kind: 'follow-up-policy', input: { subject, action: 'enable-local', expectedRevision: 0 } });
      const bridge = new FollowUpEvents(f.ctx, f.registry);
      try {
        await bridge.flush(); // Installs callbacks before there is a parent catalog row.
        child.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'Scoped native task' });
        child.append('turn/start', { turn: 1 });
        const info = { id: childId, runId: 'scoped-run' as SubagentRunId, provider: 'spawn', local: true };
        owner.ctx.emit(scopeTarget(runtime, key), 'subagent/start', info);
        await bridge.flush();
        expect(await core.read({ kind: 'follow-up-page', input: { subject } })).toMatchObject({ page: { rows: [
          { condition: { kind: 'tracking' }, origin: { sessionId: mainId, childSessionId: childId } },
        ] } });
        child.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); resident = false;
        owner.ctx.emit(scopeTarget(runtime, key), 'subagent/end', { ...info, stopReason: 'completed' });
        await Promise.resolve(); await bridge.flush();
        expect(await core.read({ kind: 'follow-up-page', input: { subject } })).toMatchObject({ page: { rows: [
          { condition: { kind: 'closed', reason: 'resolved' } },
        ] } });
        await bridge.close(); const before = reads.mock.calls.length, beforeStats = stats.mock.calls.length;
        owner.ctx.emit(scopeTarget(runtime, key), 'subagent/start', info);
        await Promise.resolve(); await bridge.flush(); expect(reads.mock.calls).toHaveLength(before);
        expect(stats.mock.calls).toHaveLength(beforeStats);
      } finally { await bridge.close(); await owner.dispose(); }
    });
  } finally { await core.close(); }
});
