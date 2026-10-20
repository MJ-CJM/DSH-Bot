import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { openAutomationStores } from '../lib/host/automation/index.js';
import { botCreateSchema, botSchema } from '../lib/shared/schema.js';
const [root, mode] = process.argv.slice(2);
const ctx = new Context();
try {
  await ctx.plugin(Storage).await();
  await ctx.plugin(storageJson, { root }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), createdAt: 1, updatedAt: 1, schemaVersion: 1 });
  const stores = await openAutomationStores(ctx, { assertOwner() {}, ownerId: `test-${process.pid}`,
    resolveBot: () => ({ bot, presetId: 'test-alpha' }), config: { quotaTimeZone: 'UTC' }, now: () => 1792497600000 });
  const routine = mode === 'write' ? await stores.routines.create({ botId: 'alpha', title: 'Routine', prompt: 'Task',
    rule: { kind: 'every', everySeconds: 60 }, timeZone: 'UTC' }) : stores.routines.list()[0];
  const queued = await stores.runs.enqueue({ trigger: 'manual', routineId: routine.id, operationId: 'bfb51246-58a8-438c-83eb-e9c4e499b94f' });
  const run = await stores.runs.reserve(queued.id);
  console.log(JSON.stringify({ id: run.id, sessionId: run.sessionId, requestId: run.requestId, count: stores.runs.control().counts[0].count,
    total: stores.runs.list().length, status: run.status }));
  await stores.close();
} finally { await ctx.fiber.dispose(); }
