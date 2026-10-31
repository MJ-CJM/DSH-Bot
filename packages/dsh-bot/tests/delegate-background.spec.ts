import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { DshBotRegistry } from '../lib/host/registry.js';
import { startDelegate } from '../lib/host/data-flow/delegation.js';

vi.mock('../lib/host/data-flow/tool-guard.js', () => ({ outlets: (registry: { memoryOutlets: unknown }) => registry.memoryOutlets }));
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const records = new Map<string, unknown>(); let sequence = 0;
  const flow = {
    draft: vi.fn((outlet: string, _from: unknown, _session: string, _call: string, _to: unknown, content: string) => ({ outlet, content, label: {} })),
    request: vi.fn(async (_owner: Agent, _env: unknown, signal?: AbortSignal) => { signal?.throwIfAborted(); }),
    admit: vi.fn(async (env: unknown, _grant: unknown, signal?: AbortSignal) => { signal?.throwIfAborted(); const id = `${++sequence}`; records.set(id, env); return id; }),
    inherit: vi.fn(async () => {}),
    dispatch: vi.fn(async (id: string, send: (env: unknown, signal: AbortSignal) => unknown, signal?: AbortSignal) => { signal?.throwIfAborted(); return send(records.get(id), signal ?? new AbortController().signal); }),
  };
  const children: { result: ReturnType<typeof deferred<SubagentResult>>; dispose: ReturnType<typeof vi.fn> }[] = [];
  const startActivation = vi.fn(async (spec: SubagentActivationSpec) => {
    const result = deferred<SubagentResult>(); const dispose = vi.fn(async () => { result.resolve({ output: [], stopReason: 'aborted' }); });
    children.push({ result, dispose }); return { childId: spec.childId, result: result.promise, dispose };
  });
  const owner = { ctx: { get: () => ({ startActivation }), logger: { warn: vi.fn() } },
    session: { id: 'main' }, followup: vi.fn() } as unknown as Agent;
  const registry = { memoryOutlets: flow } as unknown as DshBotRegistry;
  const key = { botId: 'alpha', botCreatedAt: 1 };
  const parent = new AbortController(), lifetime = new AbortController();
  const start = (call: string) => startDelegate(registry, owner, key, key, call, {
    provider: 'spawn', label: call, delivery: 'parent', signal: parent.signal,
    request: { parent: owner, prompt: [{ type: 'text', text: call }] },
  } as SubagentActivationSpec, lifetime.signal);
  return { start, owner, flow, children, parent, lifetime, startActivation };
}

describe('managed background result lifecycle (public seam double)', () => {
  it('two concurrent children survive parent Stop; disposing A leaves B and delivers B once', async () => {
    const f = fixture(); const [a, b] = await Promise.all([f.start('A'), f.start('B')]);
    expect(f.startActivation).toHaveBeenCalledTimes(2);
    expect(f.startActivation.mock.calls.every(([spec]) => spec.delivery === 'caller')).toBe(true);
    f.parent.abort(); await a.dispose();
    await expect(a.result).rejects.toThrow('Delegate cancelled');
    expect(f.children[1]?.dispose).not.toHaveBeenCalled();
    f.children[1]?.result.resolve({ output: [{ type: 'text', text: 'B complete' }], stopReason: 'completed' });
    await b.result; await b.result;
    expect(f.owner.followup).toHaveBeenCalledOnce();
    expect(f.owner.followup).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ kind: 'dsh-bot-delegate', sourceSessionId: b.childId }),
      content: expect.arrayContaining([{ type: 'text', text: 'B complete' }]),
    }));
  });
  it('native child interrupt cannot revive its parent with partial output', async () => {
    const f = fixture(); const child = await f.start('A');
    f.children[0]?.result.resolve({ output: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' });
    await child.result; expect(f.owner.followup).not.toHaveBeenCalled();
  });
  it('unload aborts delivery even after child settlement', async () => {
    const f = fixture(); const child = await f.start('A'); f.lifetime.abort();
    f.children[0]?.result.resolve({ output: [], stopReason: 'completed' });
    await expect(child.result).rejects.toThrow(); expect(f.owner.followup).not.toHaveBeenCalled();
  });
  it('failed child output is explicitly marked error and keeps native notice provenance', async () => {
    const f = fixture(); const child = await f.start('A');
    f.children[0]?.result.resolve({ output: [], stopReason: 'error' }); await child.result;
    expect(f.owner.followup).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(f.owner.followup).mock.calls)).toContain(': error');
  });
  it('a rejected content gate emits only a safe failure status, with no retry or raw output', async () => {
    const f = fixture(); const child = await f.start('A');
    f.flow.admit.mockRejectedValueOnce(new Error('private diagnostic'));
    f.children[0]?.result.resolve({ output: [{ type: 'text', text: 'SECRET' }], stopReason: 'completed' });
    await expect(child.result).rejects.toThrow('private diagnostic');
    expect(f.owner.followup).toHaveBeenCalledOnce();
    const sent = JSON.stringify(vi.mocked(f.owner.followup).mock.calls);
    expect(sent).toContain('result unavailable'); expect(sent).not.toContain('SECRET'); expect(sent).not.toContain('private diagnostic');
  });
  it('infrastructure rejection is visible and does not retry execution', async () => {
    const f = fixture(); const child = await f.start('A');
    f.children[0]?.result.reject(new Error('transport failure'));
    await expect(child.result).rejects.toThrow('transport failure');
    expect(f.owner.followup).toHaveBeenCalledOnce(); expect(f.startActivation).toHaveBeenCalledOnce();
  });
});
