import { need } from '../src/host/common/operations.js';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createScope } from '@deepseek-ai/dsh-scope';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { botCreateSchema, botSchema } from '../src/shared/schema.js';
import { openIntegrationStores } from '../src/host/common/integration-stores.js';
import { Notifications, type NotificationPort } from '../src/host/notifications/service.js';
import { Connectors } from '../src/host/connectors/service.js';
export const alpha = { botId: 'alpha', botCreatedAt: 1 };
export const beta = { botId: 'beta', botCreatedAt: 1 };
export async function withIntegrations(
  test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  port?: NotificationPort,
  options: { maxRecords?: number; retentionDays?: number } = {},
) {
  const home = fileURLToPath(new URL('../../../.dsh-dev/p34-u02-03/', import.meta.url));
  await mkdir(home, { recursive: true });
  const root = await mkdtemp(join(home, 'unit-'));
  const ctx = new Context();
  let fixture: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    fixture = await setup(ctx, root, port, options);
    await test(fixture);
  } finally {
    await fixture?.close();
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
async function setup(ctx: Context, root: string, port?: NotificationPort, options: { maxRecords?: number; retentionDays?: number } = {}) {
  await ctx.plugin(Storage).await();
  await ctx.plugin(storageJson, { root }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const bots = new Map(
    ['alpha', 'beta'].map((id) => [
      id,
      botSchema.parse({
        ...botCreateSchema.parse({ id, name: id }),
        createdAt: 1,
        updatedAt: 1,
        schemaVersion: 1,
      }),
    ]),
  );
  const registry = {
    async get(id: string) {
      const b = bots.get(id);
      if (!b) throw new Error('not-found');
      return structuredClone(b);
    },
    presetBot(id: string) {
      return need(bots.get(id));
    },
  } as Context['dshBots'];
  const stores = await openIntegrationStores(ctx);
  const clock = { at: Date.parse('2026-10-24T12:00:00Z') };
  let changes = 0;
  const notifications = new Notifications(
    ctx,
    stores,
    registry,
    {
      sendTimeoutMs: 1000,
      dailyLimit: 20,
      cooldownSec: 60,
      maxRecords: options.maxRecords ?? 1000,
      retentionDays: options.retentionDays ?? 30,
    },
    () => changes++,
    port,
    () => clock.at,
  );
  // MCP stdio starts a cold Node process plus native discovery. This is not the notification timeout.
  const connectors = new Connectors(ctx, stores, registry, 10000, () => changes++);
  const secrets = new Map<string, string>();
  ctx.provide('credentials', {
    async resolve(ref: string) {
      const value = secrets.get(ref);
      return value === undefined ? undefined : { value, source: 'synthetic' };
    },
  } as Context['credentials']);
  let owner!: Context;
  await ctx
    .plugin({
      inject: ['tools', 'approval'],
      apply(value: Context) {
        owner = value;
      },
    })
    .await();
  const createAgent = (id = 'agent-alpha', busy = false) => {
    const sessionId = SessionId(id);
    const session = Session.create(sessionId, undefined, {
      version: 4,
      id: sessionId,
      createdAt: clock.at,
      isSeeded: false,
      cwd: root,
    });
    session.append('turn/start', { turn: 0 });
    session.append('step/start', { turn: 0, step: 0 });
    let maintenance = false;
    const value = {
      id,
      session,
      ctx,
      status: busy ? 'running' : 'idle',
      async whenIdle() {
        if (value.status !== 'idle') throw new Error('test agent busy');
      },
      runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>) {
        if (value.status !== 'idle' || maintenance) throw new Error('busy');
        maintenance = true;
        return task(new AbortController().signal).finally(() => {
          maintenance = false;
        });
      },
    };
    const agent = value as unknown as Agent;
    const scope = createScope(owner, agent);
    value.ctx = scope.ctx;
    return { agent, scope, value };
  };
  return {
    ctx,
    root,
    stores,
    bots,
    registry,
    clock,
    notifications,
    connectors,
    secrets,
    createAgent,
    changes: () => changes,
    async close() {
      await notifications.close();
      await connectors.close();
      await stores.close();
    },
  };
}
export function policy(id = 'policy', channel: 'in-app' | 'im' = 'im', extra: Record<string, unknown> = {}) {
  return {
    id,
    owner: alpha,
    channel,
    ...(channel === 'im' ? { targetRef: 'target' } : {}),
    enabled: true,
    timezone: 'UTC',
    dailyLimit: 20,
    cooldownSec: 0,
    authorization: { mode: 'ask' as const },
    ...extra,
  };
}
