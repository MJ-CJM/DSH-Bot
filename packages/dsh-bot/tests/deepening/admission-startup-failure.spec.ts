import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { MemoryAdmission } from '../../src/host/memory/admission.js';
import type { MemoryKernel } from '../../src/host/memory/op-log.js';

type StreamListener = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;

async function consume(stream: AsyncIterable<unknown>) { for await (const _chunk of stream) {} }
async function* respond(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } }; }

function stubCtx(preset?: string) {
  const listeners = new Map<string, StreamListener>();
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    on: (event: string, listener: StreamListener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    get: (name: string) => {
      if (name === 'agents') return { get: () => (preset === undefined ? undefined : { ctx: {} }) };
      if (name === 'agentPresets') return { composedPreset: () => preset };
      return undefined;
    },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  };
  return { ctx: ctx as unknown as Context, listeners };
}

function fakeKernel(): MemoryKernel {
  return {
    epoch: 1,
    blocked: false,
    listeners: new Set(),
    snapshot: { forgotten: new Set(), versions: new Map() },
    assertReadable() {},
    assertOwnership() {},
    serial: (fn: () => unknown) => fn(),
    domain: { table: () => ({ get: () => undefined, put: async () => {}, delete: async () => {}, keys: () => [], entries: () => [] }) },
  } as unknown as MemoryKernel;
}

const foreign = () => ({ provider: 'mock', model: 'mock', messages: [], sessionId: SessionId('foreign-session') }) as GenerateOptions;
const stream = (listeners: Map<string, StreamListener>) => {
  const listener = listeners.get('llm/stream');
  if (!listener) throw new Error('memory final admission listener was not registered');
  return listener;
};

describe('MemoryAdmission permanent startup failure', () => {
  it('blocks unmanaged sessions while the kernel is still pending', async () => {
    const { ctx, listeners } = stubCtx();
    const admission = new MemoryAdmission(ctx);
    await expect(consume(stream(listeners)(foreign(), respond))).rejects.toThrow('Memory admission blocked');
    expect(admission.denied).toBe(1);
  });

  it('releases positively unrelated sessions once startup has permanently failed', async () => {
    const { ctx, listeners } = stubCtx();
    const admission = new MemoryAdmission(ctx);
    admission.markStartupFailed();
    await consume(stream(listeners)(foreign(), respond));
    expect(admission.denied).toBe(0);
  });

  it('still gates bot-preset sessions after a permanent startup failure', async () => {
    const { ctx, listeners } = stubCtx('bot-assistant');
    const admission = new MemoryAdmission(ctx);
    admission.markStartupFailed();
    await expect(consume(stream(listeners)(foreign(), respond))).rejects.toThrow('Memory admission blocked');
  });

  it('gates again once stopped, even after a permanent startup failure', async () => {
    const { ctx, listeners } = stubCtx();
    const admission = new MemoryAdmission(ctx);
    admission.markStartupFailed();
    await admission.close();
    await expect(consume(stream(listeners)(foreign(), respond))).rejects.toThrow('Memory admission blocked');
  });

  it('ignores a startup-failure mark once the kernel has started', async () => {
    const { ctx, listeners } = stubCtx();
    const admission = new MemoryAdmission(ctx);
    admission.start(fakeKernel());
    admission.markStartupFailed();
    await consume(stream(listeners)(foreign(), respond));
  });

  it('still gates bot-preset sessions after a permanent failure when ownership lookup fails', async () => {
    const listeners = new Map<string, StreamListener>();
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      on: (event: string, listener: StreamListener) => { listeners.set(event, listener); return () => listeners.delete(event); },
      get: () => { throw new Error('service unavailable'); },
      logger: { warn() {}, info() {}, error() {}, debug() {} },
    };
    const admission = new MemoryAdmission(ctx as unknown as Context);
    admission.markStartupFailed();
    await expect(consume(stream(listeners)(foreign(), respond))).rejects.toThrow('Memory admission blocked');
  });
});
