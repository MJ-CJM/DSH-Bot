import type { Context } from '@deepseek-ai/cordis';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-subagent/remote';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SubagentAddress, SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TypertRemoteNamespaceMap, RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { BotRecord } from '../shared/schema.js';
import type { DshBotRemoteMethods } from '../shared/remote-contract.js';
import { createPollingCatalog, type BotCatalogOptions } from './state.js';

const unwrap = <T>(result: RemoteResult<T>): T => { if (!result.ok) throw result.error; return result.value; };
export interface BackgroundTask { address: SubagentAddress; label: string; running: boolean | undefined }
export function createBackgroundActions(ctx: Context, options: BotCatalogOptions = {}) {
  return { forBot(bot: Pick<BotRecord, 'id' | 'createdAt'>) {
    const own = () => ctx.get('remote.dshBot') as DshBotRemoteMethods;
    const native = () => ctx.get('remote.subagents') as TypertRemoteNamespaceMap['subagents'];
    const identity = async () => {
      const current = unwrap(await own().get(bot.id));
      if (current.createdAt !== bot.createdAt) throw new Error('Bot identity changed');
      const main = unwrap(await own().status()).find(row => row.id === bot.id)?.mainSessionId;
      return main as SessionId | undefined;
    };
    const sessions = ctx.get('sessions') as unknown as ISessions;
    const read = async (): Promise<BackgroundTask[]> => {
      const main = await identity(); if (!main) return [];
      await sessions.refreshProjections(main);
      const state = sessions.list.getSnapshot();
      const snapshot = state.projectionsBySession[main];
      if (!snapshot || (snapshot.state !== 'ready' && !(snapshot.state === 'idle' && snapshot.values.subagentCatalog !== undefined))) throw new Error('Child catalog unavailable');
      // Same public Host status source used by native ui-subagent, even for unlisted children.
      const uiSession = ctx.get('uiSession') as unknown as { sessionStatus: { getSnapshot(): ReadonlyMap<string, { running?: boolean }> } } | undefined;
      const statuses = uiSession?.sessionStatus.getSnapshot();
      return (snapshot.values.subagentCatalog ?? []).map(child => ({
        address: { parentSessionId: main, childSessionId: child.id,
          mode: child.mode === 'continuable' ? 'continuable' : child.mode === 'one-shot' ? 'one-shot' : 'unknown' },
        label: child.label ?? child.id, running: statuses?.get(child.id)?.running ?? state.byId[child.id]?.running,
      }));
    };
    const catalog = createPollingCatalog(ctx, { tasks: [] as BackgroundTask[] }, async () => ({ tasks: await read() }), options);
    const validate = async (task: BackgroundTask) => {
      const main = await identity();
      if (main !== task.address.parentSessionId) throw new Error('Main conversation changed');
      const tasks = await read();
      const current = tasks.find(row => row.address.childSessionId === task.address.childSessionId && row.address.mode === task.address.mode);
      if (!current) throw new Error('Child no longer belongs to this Bot');
      return current;
    };
    return { catalog,
      async open(task: BackgroundTask) { await validate(task); ctx.uiWorkspace.openSession(task.address); },
      async supplement(task: BackgroundTask, text: string, delivery: 'queue' | 'steer') {
        const current = await validate(task);
        if (current.running !== true || task.address.mode !== 'continuable' || !text.trim()) throw new Error('Only a running task can accept this input');
        unwrap(await native().prompt({ ...task.address, mode: 'continuable',
          requestId: crypto.randomUUID() as SubagentPromptRequestId, delivery, content: [{ type: 'text', text: text.trim() }] }));
        await catalog.refresh();
      },
      async stop(task: BackgroundTask) {
        await validate(task);
        if (task.address.mode !== 'continuable') throw new Error('Use the native child conversation controls');
        unwrap(await native().interruptByParent(task.address.childSessionId, task.address.parentSessionId, 'continuable'));
        await catalog.refresh();
      },
      async stopAll() {
        // Snapshot explicit targets; never stops the parent or children arriving after the click.
        const targets = (await read()).filter(task => task.running !== false && task.address.mode === 'continuable');
        const results = await Promise.allSettled(targets.map(async task => {
          await validate(task);
          unwrap(await native().interruptByParent(task.address.childSessionId, task.address.parentSessionId, 'continuable'));
        }));
        await catalog.refresh();
        if (results.some(result => result.status === 'rejected')) throw new Error('Some tasks could not be stopped');
      },
      dispose: () => catalog.dispose(),
    };
  } };
}
export type BackgroundActions = ReturnType<typeof createBackgroundActions>;
