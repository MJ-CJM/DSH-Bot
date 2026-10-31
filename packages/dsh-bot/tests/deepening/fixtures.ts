import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { LlmAdapter, type GenerateOptions, type StreamChunk, createUserMessage } from '@deepseek-ai/dsh-llm';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bot-memory-forget': { kind: 'dsh-bot-memory-forget'; form: 'notice'; summary: string };
  }
}
export const forgetNotice = () => createUserMessage({ content: [{ type: 'text', text: 'REMOVED_SYNTHETIC_HISTORY' }],
  source: { kind: 'dsh-bot-memory-forget', form: 'notice', summary: 'Synthetic memory spike' } });
export const canary = 'DP_B1_SYNTHETIC_CANARY_7d56e3';
export const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const snapshots = storageDomain.defineDomain({ name: 'dp_b1_fixture', version: 1,
  tables: { snapshots: storageDomain.domainTable(z.unknown()) } });

/** Test-only adapter: no provider client, network, discovery or credentials. */
export class CaptureAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  onRequest?: (request: GenerateOptions) => void;
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    this.onRequest?.(request);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'SYNTHETIC_OK' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SYNTHETIC_OK' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export async function fixture() {
  const base = resolve('../../.dsh-dev/deepening');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'unit-'));
  const ctx = new Context();
  try {
    await ctx.plugin(Storage).await();
    await ctx.plugin(storageJson, { root }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    await mountAgentLoopTestDependencies(ctx);
    const adapter = new CaptureAdapter();
    ctx.effect(() => ctx.llm.registerAdapter(['dp-fixture'], adapter));
    const harness = await mountAgentLoopTestHarness(ctx);
    let domain = await ctx.storageDomain.open(snapshots);
    ctx.effect(() => () => domain.close());
    return { ctx, adapter, harness, domain, root,
      reopen: async () => { await domain.close(); domain = await ctx.storageDomain.open(snapshots); return domain; },
      close: async () => { try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); } },
    };
  } catch (error) {
    try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}
