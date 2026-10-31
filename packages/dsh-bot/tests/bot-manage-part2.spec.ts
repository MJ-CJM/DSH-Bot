
import { defineTool, type PreToolDecision, } from '@deepseek-ai/dsh-tools';
import { type ApprovalOutcome, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { describe, expect, it, vi } from 'vitest';
import { Config, } from '../lib/host/registry.js';
import { BOT_MANAGE_TOOL_NAME, registerBotManageTool, registerStandardBotManage } from '../lib/host/tools/bot-manage.js';

import { withFixture, successful, failure, audit, mutation } from './fixtures/bot-manage.js';

describe('bot_manage through published ToolRuntime, approval audit and JSON-backed registry', () => {
  it('propagates storage failures after approval while restoring the previous preset and JSON', async () => withFixture(async ({ ctx, registry,
    create, execute, unit, disk, presets }) => {
    const owner = create();
    ctx.on('approval/request', async () => 'allowed-once');
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const write = vi.spyOn(unit(), 'putRecord').mockRejectedValueOnce(new Error('Injected JSON write failure'));
    try { failure(await execute(owner.agent, mutation('update')), 'store/unavailable'); }
    finally { write.mockRestore(); }
    expect(await disk()).toBe(before);
    expect(presets.current.get('bot-alpha')?.name).toBe('Alpha');
  }));

  it.each(['create', 'update', 'delete'] as const)('does not persist %s after rejected, cancelled or unavailable approval',
    async (action) => withFixture(async ({ ctx, registry, create, execute, disk, presets }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.memoryFor('alpha').save({ content: 'Unchanged by a denied delete.' });
    const before = await disk();
    const calls = [...presets.calls];
    let outcome: ApprovalOutcome = 'rejected';
    ctx.on('approval/request', async () => outcome);
    for (const selected of ['rejected', 'cancelled', 'unavailable'] as const) {
      outcome = selected;
      failure(await execute(owner.agent, mutation(action)));
      expect(audit(owner.session).at(-1)).toMatchObject({ type: 'approval/decided', data: { outcome } });
      expect(await disk()).toBe(before);
      expect(presets.calls).toEqual(calls);
      expect((await registry.get('alpha')).name).toBe('Alpha');
    }
  }));

  it('fails closed with no approval service while list/get remain available', async () => withFixture(async ({ registry, create, execute, disk, presets }) => {
    const owner = create();
    const original = await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const calls = [...presets.calls];
    for (const action of ['create', 'update', 'delete'] as const) failure(await execute(owner.agent, mutation(action)));
    expect(await disk()).toBe(before);
    expect(presets.calls).toEqual(calls);
    expect(successful(await execute(owner.agent, { action: 'list' }))).toEqual({ action: 'list', bots: [original] });
    expect(successful(await execute(owner.agent, { action: 'get', id: 'alpha' }))).toEqual({ action: 'get', bots: [original] });
    expect(audit(owner.session)).toEqual([]);
  }, { approval: false }));

  it('honors session never policy and fails closed when no answerer is present', async () => withFixture(async ({ ctx, registry, create,
    execute, disk, presets }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const calls = [...presets.calls];
    failure(await execute(owner.agent, mutation('update')));
    expect(audit(owner.session).at(-1)).toMatchObject({ data: { outcome: 'unavailable' } });
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    ctx.on('approval/request', answer);
    setApprovalPolicy(owner.session, 'never');
    failure(await execute(owner.agent, mutation('delete')));
    expect(audit(owner.session).at(-1)).toMatchObject({ data: { outcome: 'rejected' } });
    expect(answer).not.toHaveBeenCalled();
    expect(await disk()).toBe(before);
    expect(presets.calls).toEqual(calls);
  }));

  it('asks afresh after a one-shot grant and never reuses it for the next mutation', async () => withFixture(async ({ ctx, registry, create,
    execute, disk }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const answer = vi.fn<() => Promise<ApprovalOutcome>>()
      .mockResolvedValueOnce('allowed-once').mockResolvedValueOnce('rejected');
    ctx.on('approval/request', answer);
    successful(await execute(owner.agent, mutation('create')));
    const before = await disk();
    failure(await execute(owner.agent, mutation('update')));
    expect(answer).toHaveBeenCalledTimes(2);
    expect(await disk()).toBe(before);
    const asked = audit(owner.session).filter((event) => event.type === 'approval/asked');
    expect(asked).toHaveLength(2);
    expect(asked[0]?.data.id).not.toBe(asked[1]?.data.id);
  }));

  it('cancels a pending approval without writing, including after a late allow answer', async () => withFixture(async ({ ctx, registry, create,
    execute, disk, presets }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const calls = [...presets.calls];
    let entered!: () => void;
    let release!: (value: ApprovalOutcome) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const answer = new Promise<ApprovalOutcome>((resolve) => { release = resolve; });
    ctx.on('approval/request', async () => { entered(); return answer; });
    const controller = new AbortController();
    const pending = execute(owner.agent, mutation('update'), controller.signal);
    await started;
    controller.abort();
    try { failure(await pending, 'ABORTED_BEFORE_DISPATCH'); }
    finally { release('allowed-once'); }
    expect(audit(owner.session).at(-1)).toMatchObject({ data: { outcome: 'cancelled' } });
    expect(await disk()).toBe(before);
    expect(presets.calls).toEqual(calls);
  }));

  it.each(['deny', 'cancel'] as const)('preserves an existing %s policy instead of replacing it with approval',
    async (kind) => withFixture(async ({ ctx, registry, create, execute, disk }) => {
    const owner = create();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const before = await disk();
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    ctx.on('approval/request', answer);
    owner.agent.ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => kind === 'deny'
      ? { kind, reason: 'Existing deny policy', info: { name: 'FixturePolicyError', code: 'fixture/denied' } } : { kind });
    const rejected = await execute(owner.agent, mutation('update'));
    failure(rejected, kind === 'deny' ? 'fixture/denied' : 'ABORTED_BEFORE_DISPATCH');
    expect(answer).not.toHaveBeenCalled();
    expect(audit(owner.session)).toEqual([]);
    expect(await disk()).toBe(before);
  }));

  it('isolates Agent scopes, leaves unrelated tools unprompted and disposes tool plus approval hook', async () => withFixture(async ({ ctx,
    registry, create, execute }) => {
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const first = create();
    const second = create();
    const plain = create({ install: false });
    const answer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once');
    ctx.on('approval/request', answer);
    const passthrough = defineTool({
      name: 'fixture_read', description: 'A harmless unrelated tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'read',
    });
    first.agent.ctx.effect(() => first.agent.ctx.tools.register(passthrough));
    expect(await execute(first.agent, {}, undefined, 'fixture_read')).toMatchObject({ isError: false, value: 'read' });
    expect(answer).not.toHaveBeenCalled();
    expect(ctx.tools.schemas()).toEqual([]);
    failure(await execute(plain.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    failure(await execute(undefined, { action: 'list' }), 'UNKNOWN_TOOL');
    first.dispose?.();
    first.dispose?.();
    failure(await execute(first.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    // A replacement under the same name proves the old ask listener was removed.
    first.agent.ctx.effect(() => first.agent.ctx.tools.register({ ...passthrough, name: BOT_MANAGE_TOOL_NAME }));
    expect(await execute(first.agent, mutation('create'))).toMatchObject({ isError: false, value: 'read' });
    expect(answer).not.toHaveBeenCalled();
    successful(await execute(second.agent, { action: 'list' }));
    await second.scope.dispose();
    failure(await execute(second.agent, { action: 'list' }), 'UNKNOWN_TOOL');
  }));

  it('hands ownership to a replacement registration while stale disposers cannot remove its tool or approval hook',
    async () => withFixture(async ({ ctx, registry, create, execute }) => {
    const owner = create({ install: false });
    const originalList = vi.fn(async () => []);
    const originalDisposed = vi.fn();
    const currentDisposed = vi.fn();
    const old = registerBotManageTool(owner.agent, {
      list: originalList, get: registry.get.bind(registry), create: registry.create.bind(registry),
      update: registry.update.bind(registry), remove: registry.remove.bind(registry),
      memoryFor: registry.memoryFor.bind(registry), config: registry.config,
    }, originalDisposed);
    successful(await execute(owner.agent, { action: 'list' }));
    expect(originalList).toHaveBeenCalledTimes(1);
    const current = registerBotManageTool(owner.agent, registry, currentDisposed);
    expect(originalDisposed).toHaveBeenCalledTimes(1);
    old();
    old();
    expect(currentDisposed).not.toHaveBeenCalled();
    const answer = vi.fn<() => Promise<ApprovalOutcome>>()
      .mockResolvedValueOnce('rejected').mockResolvedValueOnce('allowed-once');
    ctx.on('approval/request', answer);
    failure(await execute(owner.agent, mutation('create')));
    expect(await registry.list()).toEqual([]);
    successful(await execute(owner.agent, mutation('create')));
    expect(answer).toHaveBeenCalledTimes(2);
    successful(await execute(owner.agent, { action: 'list' }));
    expect(originalList).toHaveBeenCalledTimes(1);
    expect(ctx.tools.schemas(owner.agent).filter((tool) => tool.name === BOT_MANAGE_TOOL_NAME)).toHaveLength(1);
    current();
    current();
    expect(currentDisposed).toHaveBeenCalledTimes(1);
    owner.agent.ctx.effect(() => owner.agent.ctx.tools.register(defineTool({
      name: BOT_MANAGE_TOOL_NAME, description: 'Replacement after complete cleanup', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'clean',
    })));
    expect(await execute(owner.agent, {})).toMatchObject({ isError: false, value: 'clean' });
    expect(answer).toHaveBeenCalledTimes(2);
    await owner.scope.dispose();
    expect(originalDisposed).toHaveBeenCalledTimes(1);
    expect(currentDisposed).toHaveBeenCalledTimes(1);
  }));

  it('defaults standard exposure off and gives only exact standard sessions a disposable registration', async () => withFixture(async ({ ctx,
    create, execute }) => {
    expect(Config(undefined).enableBotManageInStandard).toBe(false);
    expect(Config({ enableBotManageInStandard: true }).enableBotManageInStandard).toBe(true);
    expect(() => Config({ enableBotManageInStandard: 'true' } as never)).toThrow();
    const before = create({ install: false, agentPreset: 'standard' });
    await before.announce();
    failure(await execute(before.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    const plugin = ctx.plugin({ inject: ['tools', 'dshBots', 'agentPresets', 'agents'], apply: registerStandardBotManage });
    await plugin.await();
    const first = create({ install: false, agentPreset: 'standard' });
    const second = create({ install: false, agentPreset: 'standard' });
    const bot = create({ agentPreset: 'bot-alpha' });
    for (const subject of [first, second, bot]) await subject.announce();
    // Replayed creation announcements must not install a duplicate local tool.
    await first.announce();
    successful(await execute(first.agent, { action: 'list' }));
    for (const agentPreset of ['minimal', 'standard-copy', 'bot-standard', undefined]) {
      const other = create({ install: false, ...(agentPreset === undefined ? {} : { agentPreset }) });
      await other.announce();
      failure(await execute(other.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    }
    expect(ctx.tools.schemas()).toEqual([]);
    await first.scope.dispose();
    failure(await execute(first.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    successful(await execute(second.agent, { action: 'list' }));
    await plugin.dispose();
    failure(await execute(second.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    successful(await execute(bot.agent, { action: 'list' }));
    const after = create({ install: false, agentPreset: 'standard' });
    await after.announce();
    failure(await execute(after.agent, { action: 'list' }), 'UNKNOWN_TOOL');
  }));

  it('uses the restored composition when persisted selection differs from the creation header', async () => withFixture(async ({ ctx, create, execute }) => {
    await ctx.plugin({ inject: ['tools', 'dshBots', 'agentPresets', 'agents'], apply: registerStandardBotManage }).await();
    const intoStandard = create({ install: false, agentPreset: 'minimal', composedPreset: 'standard', blank: true, resume: true });
    const fromStandard = create({ install: false, agentPreset: 'standard', composedPreset: 'minimal', blank: true, resume: true });
    for (const subject of [intoStandard, fromStandard]) await subject.announce();
    expect(intoStandard.session.header.agentPreset).toBe('minimal');
    expect(intoStandard.session.snapshotEvents().findLast((event) => event.type === 'agent-preset/selected')).toMatchObject(
      { data: { agentPreset: 'standard' } });
    expect(fromStandard.session.header.agentPreset).toBe('standard');
    expect(fromStandard.session.snapshotEvents().findLast((event) => event.type === 'agent-preset/selected')).toMatchObject(
      { data: { agentPreset: 'minimal' } });
    successful(await execute(intoStandard.agent, { action: 'list' }));
    failure(await execute(fromStandard.agent, { action: 'list' }), 'UNKNOWN_TOOL');
  }));

  it('follows standard/minimal switches on blank sessions and removes switch listeners on disposal', async () => withFixture(async ({ ctx,
    create, execute }) => {
    const plugin = ctx.plugin({ inject: ['tools', 'dshBots', 'agentPresets', 'agents'], apply: registerStandardBotManage });
    await plugin.await();
    const standard = create({ install: false, agentPreset: 'standard', blank: true });
    const minimal = create({ install: false, agentPreset: 'minimal', blank: true });
    for (const subject of [standard, minimal]) await subject.announce();
    successful(await execute(standard.agent, { action: 'list' }));
    failure(await execute(minimal.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    await standard.select('minimal');
    await minimal.select('standard');
    failure(await execute(standard.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    successful(await execute(minimal.agent, { action: 'list' }));
    await standard.select('standard');
    await minimal.select('minimal');
    successful(await execute(standard.agent, { action: 'list' }));
    failure(await execute(minimal.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    expect(standard.session.header.agentPreset).toBe('standard');
    expect(minimal.session.header.agentPreset).toBe('minimal');
    expect([standard, minimal].every(({ session }) => !session.snapshotEvents().some((event) => event.type === 'turn/start'))).toBe(true);
    await minimal.scope.dispose();
    await minimal.select('standard');
    failure(await execute(minimal.agent, { action: 'list' }), 'UNKNOWN_TOOL');
    await plugin.dispose();
    await standard.select('minimal');
    await standard.select('standard');
    failure(await execute(standard.agent, { action: 'list' }), 'UNKNOWN_TOOL');
  }));
});
