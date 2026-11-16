import { expect, test } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { registerSupergroupTool } from '../src/host/supergroup/tool.js';

function fixture() {
  const listeners = new Map<string, Set<() => void>>(), tools = new Map<string, ToolDefinition>(), prompts = new Map<string, unknown>(), contexts = new Map<string, unknown>();
  let cleanup: (() => void) | undefined;
  const calls: unknown[] = [];
  const registry = { config: { supergroup: { enabled: false, maxExperts: 16, allowedBotIds: ['beta'] } }, supergroup: undefined as undefined | { invoke(...args: unknown[]): Promise<unknown>; continuationInstruction?(): string },
    onboardingSnapshot: () => ({ tools: { deny: [] as string[] } }), directorySnapshot: () => ['alpha', 'beta', 'private-unallowed'].map(id => ({ id, name: id, description: id })) };
  const ctx = { effect: (factory: () => () => void) => { cleanup = factory(); return cleanup; }, get: () => registry,
    on: (name: string, callback: () => void) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); },
    tools: { get: (name: string) => tools.get(name), register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    systemPrompt: { section: (section: { name: string }) => { prompts.set(section.name, section); return () => prompts.delete(section.name); },
      context: (entry: { name: string }) => { contexts.set(entry.name, entry); return () => contexts.delete(entry.name); } },
  };
  const agent = { id: 'main', ctx, session: { id: 'main', header: {} } } as unknown as Agent;
  bindings.set(agent, { botId: 'alpha', botCreatedAt: 1 });
  registerSupergroupTool(agent);
  return { agent, registry, tools, prompts, contexts, calls,
    emit: () => { for (const callback of listeners.get('dsh-bot/supergroup-changed') ?? []) callback(); },
    activate: () => { registry.supergroup = { invoke: async (...args) => { calls.push(args); return { workId: 'work' }; } }; registry.config.supergroup.enabled = true; },
    exec: (override: object = {}) => ({ agent, name: 'bot_supergroup', arguments: { action: 'start', memberIds: ['alpha', 'beta'] }, signal: new AbortController().signal, ...override }) as unknown as ToolRunContext,
    close: () => cleanup?.(), listeners };
}

test('late service and volatile changes register/remove the exact tool and scope prompt without a new Bot session', () => {
  const f = fixture();
  expect(f.tools.size).toBe(0); f.activate(); f.emit();
  expect(f.tools.has('bot_supergroup')).toBe(true);
  expect(JSON.stringify([...f.prompts.values()])).toContain('beta');
  expect(JSON.stringify([...f.prompts.values()])).not.toContain('private-unallowed');
  f.registry.config.supergroup.enabled = false; f.emit();
  expect(f.tools.size).toBe(0); expect(f.prompts.size).toBe(0);
  f.close(); expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
});

test('disabled mode does not read Bot snapshots from older Host fixtures', () => {
  const f = fixture();
  Reflect.deleteProperty(f.registry, 'onboardingSnapshot');
  expect(() => f.emit()).not.toThrow();
  expect(f.tools.size).toBe(0); expect(f.prompts.size).toBe(0);
  f.close();
});

test('the bounded prompt directory uses the same owner-first sorted pool as Host admission', () => {
  const f = fixture();
  f.registry.directorySnapshot = () => ['gamma', ...Array.from({ length: 20 }, (_, i) => `expert-${String(i).padStart(2, '0')}`), 'beta', 'alpha']
    .map(id => ({ id, name: id, description: id }));
  f.registry.config.supergroup.allowedBotIds = []; f.registry.config.supergroup.maxExperts = 2;
  f.activate(); f.emit();
  const prompt = [...f.prompts.values()][0] as { text: string };
  expect(JSON.parse(prompt.text.slice(prompt.text.lastIndexOf('\n') + 1)).map((row: { id: string }) => row.id))
    .toEqual(['alpha', 'beta', 'expert-00']);
  expect(prompt.text).not.toContain('gamma'); expect(prompt.text).not.toContain('expert-19');
  f.close();
});

test('only the owned root invocation reaches the coordinator; nested calls and replaced definitions are rejected', async () => {
  const f = fixture(); f.activate(); f.emit();
  try {
    const definition = f.tools.get('bot_supergroup')!;
    expect(await definition.execute!(f.exec().arguments, f.exec())).toEqual({ workId: 'work' });
    await expect(definition.execute!(f.exec().arguments, f.exec({ parent: {} }))).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    f.tools.set('bot_supergroup', { ...definition });
    await expect(definition.execute!(f.exec().arguments, f.exec())).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test('tool rejects model-supplied task text and removes registration under current Bot tool deny policy', async () => {
  const f = fixture(); f.activate(); f.emit();
  try {
    const definition = f.tools.get('bot_supergroup')!;
    const invalid = f.exec({ arguments: { action: 'start', memberIds: ['alpha', 'beta'], task: 'private context' } });
    await expect(definition.execute!(invalid.arguments, invalid)).rejects.toThrow();
    f.registry.onboardingSnapshot = () => ({ tools: { deny: ['bot_supergroup'] } }); f.emit();
    expect(f.tools.size).toBe(0); expect(f.prompts.size).toBe(0); expect(f.calls).toHaveLength(0);
  } finally { f.close(); }
});


test('receipt routing is required dynamic runtime context and unregisters with the original scope', () => {
  const f = fixture(); let exactReceipt = '';
  try {
    f.activate(); f.registry.supergroup!.continuationInstruction = () => exactReceipt; f.emit();
    const provider = f.contexts.get('dsh-bot:original-task-continuation') as { required: boolean; interpolate: boolean; text(): string };
    expect(provider.required).toBe(true); expect(provider.interpolate).toBe(false);
    expect(provider.text()).toBe('');
    exactReceipt = 'Receipt-bound original request routing';
    expect(provider.text()).toBe(exactReceipt);
    expect(f.prompts.has('dsh-bot:original-task-continuation')).toBe(false);
    f.registry.config.supergroup.enabled = false; f.emit(); expect(f.contexts.size).toBe(0);
  } finally { f.close(); }
});
