import { randomBytes } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryKernel } from '../memory/op-log.js';

export function outletInventory(ctx: Context) {
  const messages = ctx.get('dshBotMessaging')?.store.rows() ?? [];
  const notifications = ctx.get('dshBotNotifications')?.list() ?? [];
  return { count: messages.length + notifications.length, stamp: { messages, notifications } };
}
/** The preview counts these conservative copies. Preserve random identity/dedup barriers, erase content and hashes. */
export async function eraseOutletCopies(ctx: Context, kernel: MemoryKernel) {
  const messages = ctx.get('dshBotMessaging');
  if (messages) {
    await messages.settled();
    await messages.store.run(async () => {
      const domain = messages.store.domain;
      for (const row of messages.store.rows()) {
        const flow = row.flowId && kernel.domain.table('flows').get(row.flowId);
        if (flow && flow.envelope?.binding.epoch === kernel.epoch) continue;
        const tomb = domain.table('dedupe').get(row.envelope.id), opaque = randomBytes(32).toString('hex');
        if (tomb) await domain.table('dedupe').put(tomb.id, { ...tomb, invocationDigest: opaque });
        else await domain.table('dedupe').put(row.envelope.id, { id: row.envelope.id, messageId: row.envelope.id,
          invocationKey: row.invocationKey, invocationDigest: opaque, at: row.envelope.ts });
        for (const [id, reservation] of domain.table('limits').entries()) if (reservation.invocationKey === row.invocationKey)
          await domain.table('limits').put(id, { ...reservation, invocationDigest: opaque });
        await domain.table('messages').delete(row.envelope.id);
      }
      for (const [id] of domain.table('threads').entries())
        if (!messages.store.rows().some(r => r.envelope.threadId === id)) await domain.table('threads').delete(id);
    });
  }
  await ctx.get('dshBotNotifications')?.forgetCleanup(kernel.epoch);
}
