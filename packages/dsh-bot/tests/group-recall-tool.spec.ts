import { randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { buildForkSeed, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';
import { BOT_GROUP_RECALL_TOOL_NAME, installLiveGroupRecall, protectGroupRecall, registerGroupRecallTool } from '../src/host/groups/recall-tool.js';
import { groupRecallReference } from '../src/host/groups/recall.js';
import { MemoryAdmission } from '../src/host/memory/admission.js';
import { ForgetPreviews } from '../src/host/memory/forget-preview.js';
import { ForgetRunner } from '../src/host/memory/forget-runner.js';
import type { DshBotRegistry } from '../src/host/registry.js';
import type { DataLabel } from '../src/shared/data-flow.js';
import { groupRecallPageSchema, type GroupRecallItem, type GroupRecallPage } from '../src/shared/group-recall.js';
import { fixture, input } from './deepening/fixtures.js';
import { v2Fixture } from './deepening/v2-fixtures.js';

const owner = { botId: 'alpha', botCreatedAt: 1 };
const workGroup = { groupId: 'group:research', groupCreatedAt: 12 };
const content = 'SYNTHETIC_GROUP_SOURCE_NOT_A_MEMORY';
const item = (n: string): GroupRecallItem => ({
  group: workGroup, groupName: 'Research group', turnId: `turn:${n}`, deliveryId: `delivery:${n}`,
  memberId: 'member:alpha', childSessionId: `child:${n}`, state: 'completed', at: 20,
  sources: [{ sessionId: 'group-root', messageId: `message:${n}`, seq: 1, role: 'answer', text: content }],
});
const page = (...items: GroupRecallItem[]): GroupRecallPage => ({ items, incomplete: false });
const sourceLabel: DataLabel = { readers: [owner], originTrust: 'candidate', restrictions: ['no-egress'], grants: [], sourceVersions: [] };
const model = { provider: 'dp-fixture', model: 'mock' };

function resultPage(result: ToolExecutionResult) {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  return groupRecallPageSchema.parse(JSON.parse(String(result.value)));
}

async function withSetup(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await f.close(); }
}

async function setup() {
  const native = await fixture();
  try {
    const memory = await v2Fixture();
    try {
      const agent = await native.harness.create(SessionId('recall-main'), model);
      const recall = vi.fn<Context['dshBotGroups']['recall']>(async (_bot, args) => page(item(args.query ?? 'one')));
      const validateRecall = vi.fn<Context['dshBotGroups']['validateRecall']>(async (_bot, items) => items.length > 0);
      const validateRecallReferences = vi.fn<Context['dshBotGroups']['validateRecallReferences']>(async () => true);
      native.ctx.provide('dshBotGroups', { recall, validateRecall, validateRecallReferences } as unknown as Context['dshBotGroups']);
      let mainId: string = agent.session.id;
      let alpha = memory.alpha;
      const inherit = vi.fn(async (_sessionId: string, _label: DataLabel) => {});
      const recordRead = vi.fn(async (_sessionId: string, _versionIds: string[]) => {});
      const registry = {
        get memoryKernel() { return memory.kernel; },
        config: { groupRecall: { maxTrackedReads: 8, timeoutMs: 4000 } },
        presetBot: (id: string) => memory.bots.get(id), mainSessions: { find: async () => ({ sessionId: mainId }),
          boundSessionId: (id: string, createdAt: number) => id === owner.botId && createdAt === owner.botCreatedAt ? mainId : undefined },
        memoryAdmission: { assertAllowed() {
          memory.kernel.assertReadable();
          if (memory.kernel.blocked) throw new Error('Memory admission blocked');
        }, recordRead },
        memoryOutlets: { label: () => sourceLabel, inherit },
      } as unknown as DshBotRegistry;
      agent.ctx.effect(() => registerGroupRecallTool(agent, owner, registry));
      return {
        native, memory, agent, registry, recall, validateRecall, validateRecallReferences, inherit, recordRead,
        replaceMain(id: string) { mainId = id; },
        receipt() { return memory.kernel.domain.table('recall_reads').get(agent.session.id); },
        execute(args: unknown = {}, actor: Agent = agent, signal = new AbortController().signal) {
          return native.ctx.tools.execute({ agent: actor, name: BOT_GROUP_RECALL_TOOL_NAME, arguments: args, signal, callId: ToolCallId(randomUUID()) });
        },
        async reopen() { alpha = (await memory.reopen()).alpha; },
        async forget(sessionIds: string[], choice: 'clean' | 'stop' = 'clean') {
          const record = await alpha.save({ content: `Unrelated memory ${randomUUID()}` });
          const previews = new ForgetPreviews(memory.kernel, async () => ({ sessionIds, historyNodes: sessionIds.length,
            summaries: 0, copies: 0, pendingMessages: 0, conservative: true, rootInstructions: false, stamp: 1 }));
          const runner = new ForgetRunner(memory.kernel, previews, { drain: async () => {}, history: async () => [],
            copies: async () => {}, verifyInventory: async () => [] });
          try {
            const preview = await previews.create({ memoryId: record.id, mode: 'version' });
            const result = await runner.choose({ previewRevision: preview.previewRevision, choice });
            expect(result.strong).toBe(choice === 'clean');
            expect(memory.kernel.blocked).toBe(choice === 'stop');
            return result;
          } finally { await runner.close(); }
        },
        async close() { try { await native.close(); } finally { await memory.close(); } },
      };
    } catch (error) { await memory.close(); throw error; }
  } catch (error) { await native.close(); throw error; }
}

describe('group recall through native tool dispatch and a durable memory domain', () => {
  it('returns an honest empty or unavailable page without tracking a read', () => withSetup(async f => {
    for (const expected of [page(), { items: [], incomplete: true, unavailable: true }] satisfies GroupRecallPage[]) {
      f.recall.mockResolvedValueOnce(expected);
      expect(resultPage(await f.execute())).toEqual(expected);
    }
    expect(f.validateRecall).not.toHaveBeenCalled();
    expect(f.inherit).not.toHaveBeenCalled();
    expect(f.receipt()).toBeUndefined();
  }));

  it('rejects a different native agent, forged identity fields and a stale main mapping before reading', () => withSetup(async f => {
    const other = await f.native.harness.create(SessionId('recall-other'), model);
    expect((await f.execute({}, other)).isError).toBe(true);
    expect((await f.execute({ botId: 'beta' })).isError).toBe(true);
    f.replaceMain(other.session.id);
    expect((await f.execute()).isError).toBe(true);
    expect(f.recall).not.toHaveBeenCalled();
    expect(f.receipt()).toBeUndefined();
  }));

  it.each(['cancel', 'epoch'] as const)('rejects an in-flight result when %s changes before publication', mode => withSetup(async f => {
    const abort = new AbortController();
    f.recall.mockImplementationOnce(async () => {
      if (mode === 'cancel') abort.abort();
      else await f.forget([]);
      return page(item('late'));
    });
    expect((await f.execute({}, f.agent, abort.signal)).isError).toBe(true);
    expect(f.inherit).not.toHaveBeenCalled();
    expect(f.receipt()).toBeUndefined();
  }));

  it('merges concurrent reads in the durable queue and persists hashes without excerpts', () => withSetup(async f => {
    let release = () => {};
    const arrived = new Promise<void>(resolve => { release = resolve; });
    let count = 0;
    f.inherit.mockImplementation(async () => {
      if (++count === 2) release();
      await arrived;
    });
    const results = await Promise.all([f.execute({ query: 'one' }), f.execute({ query: 'two' })]);
    expect(results.map(result => resultPage(result).items[0]?.deliveryId)).toEqual(['delivery:one', 'delivery:two']);
    const persisted = f.receipt();
    expect(persisted?.references.map(row => row.deliveryId).sort()).toEqual(['delivery:one', 'delivery:two']);
    expect(persisted?.references[0]?.sources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(content);
    expect(f.inherit).toHaveBeenCalledWith(f.agent.session.id, sourceLabel);
  }));

  it('retains cold read dependencies through unrelated cleanup and admits only an exactly verified clean session', () => withSetup(async f => {
    expect(resultPage(await f.execute()).items).toEqual([item('one')]);
    await f.forget(['some-other-session']);
    await f.reopen();
    expect(f.receipt()).toMatchObject({ sessionId: f.agent.session.id, bot: owner, references: [{ turnId: 'turn:one' }] });
    f.validateRecallReferences.mockClear();
    f.validateRecallReferences.mockResolvedValue(false);
    const release = protectGroupRecall(f.agent, owner, f.registry);
    try {
      f.agent.followup(input('Check stale group history')); await f.agent.whenIdle();
      expect(f.validateRecallReferences).toHaveBeenCalled();
      expect(f.native.adapter.requests).toHaveLength(0);
      f.validateRecallReferences.mockClear();
      const other = await f.native.harness.create(SessionId('recall-unrelated'), model);
      other.followup(input('Unrelated chat')); await other.whenIdle();
      expect(f.validateRecallReferences).not.toHaveBeenCalled();
      expect(f.native.adapter.requests).toHaveLength(1);
      await f.forget([f.agent.session.id]);
      f.validateRecallReferences.mockClear();
      f.agent.followup(input('After verification')); await f.agent.whenIdle();
      expect(f.validateRecallReferences).not.toHaveBeenCalled();
      expect(f.native.adapter.requests).toHaveLength(2);
    } finally { release(); }
  }));

  it('rechecks and cancels on the exact committed group change without reacting to unrelated facts', () => withSetup(async f => {
    expect(resultPage(await f.execute()).items).toEqual([item('one')]);
    f.validateRecallReferences.mockClear();
    f.validateRecallReferences.mockResolvedValue(false);
    const cancel = vi.spyOn(f.agent, 'cancel');
    const release = protectGroupRecall(f.agent, owner, f.registry);
    try {
      f.native.ctx.emit('dsh-bot/group-fact-changed', { ...workGroup, groupCreatedAt: 13 }, 'turn:one');
      f.native.ctx.emit('dsh-bot/group-fact-changed', workGroup, 'turn:other');
      expect(f.validateRecallReferences).not.toHaveBeenCalled();
      f.native.ctx.emit('dsh-bot/group-fact-changed', workGroup, 'turn:one');
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'Group recall source changed' }, { keepInbox: true }));
      expect(f.validateRecallReferences).toHaveBeenCalledTimes(1);
    } finally { release(); }
  }));

  it('revalidates exact inherited results across forks and requires a canonical receipt when native lineage is absent', () => withSetup(async f => {
    const stream = f.native.adapter.stream.bind(f.native.adapter);
    let issueTool = true;
    vi.spyOn(f.native.adapter, 'stream').mockImplementation(async function* (options) {
      if (!issueTool || options.sessionId !== f.agent.session.id) { yield* stream(options); return; }
      issueTool = false;
      const id = ToolCallId('fork-recall-source'), args = '{}';
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: BOT_GROUP_RECALL_TOOL_NAME, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: BOT_GROUP_RECALL_TOOL_NAME, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    });
    f.agent.followup(input('Find my group work')); await f.agent.whenIdle();
    const receipt = f.receipt();
    if (!receipt) throw new Error('Expected a durable tool read receipt');
    const fork = async (parent: Agent, id: string, hasNativeParent = true) => {
      const events = parent.session.snapshotEvents(), boundary = events.at(-1)?.seq;
      if (boundary === undefined) throw new Error('Missing native fork boundary');
      return f.native.ctx.agents.create({ sessionId: SessionId(id), agentOptions: model, seed: buildForkSeed(events, boundary),
        inheritedEventCount: SessionLogOffset(boundary + 1),
        meta: { ...(hasNativeParent ? { parentSession: parent.session.id } : {}), isSeeded: true } });
    };
    const first = await fork(f.agent, 'recall-branch'), second = await fork(first.agent, 'recall-branch-grandchild');
    const desktop = await fork(f.agent, 'recall-seeded-without-parent', false);
    const releases = [first, second, desktop].map(({ agent }) => protectGroupRecall(agent, owner, f.registry));
    releases.push(installLiveGroupRecall(desktop.agent, owner, f.registry, 1));
    try {
      const send = async (agent: Agent, text: string) => { agent.followup(input(text)); await agent.whenIdle(); };
      await send(first.agent, 'First fork');
      await send(second.agent, 'Second fork');
      await send(desktop.agent, 'A native fork without parent metadata can use the exact canonical receipt');
      expect(f.native.adapter.requests.map(request => request.sessionId)).toEqual(expect.arrayContaining([second.agent.session.id, desktop.agent.session.id]));
      expect(f.validateRecallReferences).toHaveBeenLastCalledWith(owner, receipt.references, expect.any(AbortSignal), { retainedRead: true });
      expect(desktop.agent.ctx.tools.get(BOT_GROUP_RECALL_TOOL_NAME, desktop.agent)).toBeUndefined();
      const requestCount = f.native.adapter.requests.length;

      f.replaceMain(first.agent.session.id);
      f.validateRecallReferences.mockClear();
      await send(desktop.agent, 'An alternate main cannot authorize this fork');
      expect(f.validateRecallReferences).not.toHaveBeenCalled();
      expect(f.native.adapter.requests).toHaveLength(requestCount);
      f.replaceMain(f.agent.session.id);

      await f.forget([f.agent.session.id]);
      f.validateRecallReferences.mockResolvedValue(false);
      await send(second.agent, 'Parent cleanup is not this fork’s cleanup');
      await send(desktop.agent, 'The canonical main’s cleanup does not release this fork');
      expect(f.native.adapter.requests).toHaveLength(requestCount);

      await f.memory.kernel.domain.table('recall_reads').put(f.agent.session.id, { ...receipt, epoch: f.memory.kernel.epoch,
        references: [groupRecallReference(item('different-read'))] });
      f.validateRecallReferences.mockClear();
      f.validateRecallReferences.mockResolvedValue(true);
      await send(first.agent, 'A different receipt cannot authorize the copied tool result');
      await send(desktop.agent, 'A different canonical receipt cannot authorize the copied tool result');
      expect(f.validateRecallReferences).not.toHaveBeenCalled();
      expect(f.native.adapter.requests).toHaveLength(requestCount);
    } finally {
      for (const release of releases) release();
      await desktop.dispose(); await second.dispose(); await first.dispose();
    }
  }));

  it('lets the existing native cleanup audit inspect a blocked conversation without a model request', () => withSetup(async f => {
    const admission = new MemoryAdmission(f.native.ctx);
    admission.start(f.memory.kernel);
    admission.protect(f.agent);
    const release = protectGroupRecall(f.agent, owner, f.registry);
    try {
      expect(resultPage(await f.execute()).items).toEqual([item('one')]);
      await f.forget([f.agent.session.id], 'stop');
      f.validateRecallReferences.mockClear();
      const request = await admission.verifyRequest(f.agent);
      expect(request.sessionId).toBe(f.agent.session.id);
      expect(f.validateRecallReferences).not.toHaveBeenCalled();
      expect(f.native.adapter.requests).toHaveLength(0);
    } finally { release(); await admission.close(); }
  }));
});
