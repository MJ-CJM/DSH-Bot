import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import * as Json from '@deepseek-ai/dsh-storage-json';
import { openAutomationStores } from '../../lib/host/automation/store.js';
import { MainSessionDelivery } from '../../lib/host/automation/delivery.js';
import { botCreateSchema, botSchema } from '../../lib/shared/schema.js';
import { checkpoint } from './crash-checkpoint.mjs';

const [phase, outputDir, nonce] = process.argv.slice(2), ctx = new Context();
const config = { phase, outputDir, nonce, window: 'business-submission' };
const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), createdAt: 1, updatedAt: 1, schemaVersion: 1 });
const identityPath = resolve(outputDir, 'identity.json'), effectPath = resolve(outputDir, 'effect.json');
await ctx.plugin(Storage).await(); await ctx.plugin(Json, { root: resolve(outputDir, 'storage') }).await();
await ctx.plugin(Domain, { backend: 'json' }).await();
const stores = await openAutomationStores(ctx, { resolveBot: async () => ({ bot, presetId: 'bot-alpha' }) });
let calls = 0;
// Explicit UNIT seam: Controller is a double. RunService, MainSessionDelivery and fsync/JSON are real.
ctx.provide('sessionController', { prompt: async () => {
  calls++;
  const file = await open(effectPath, 'wx');
  try { await file.writeFile(JSON.stringify({ calls: 1, syntheticEffect: true })); await file.sync(); }
  finally { await file.close(); }
  await checkpoint(config, { phase: 'synthetic-effect-durable-before-delivery-receipt', calls });
  return { accepted: true };
} });
const sender = new MainSessionDelivery(ctx, { get: async () => bot, openConversation: async () => ({ sessionId: 'synthetic-main' }) }, stores.runs);
try {
  if (phase === 'crash') {
    const request = { trigger: 'manual', nativeScheduleId: 'synthetic-native-task', operationId: randomUUID(),
      botId: bot.id, botCreatedAt: bot.createdAt, title: 'Business test', prompt: 'Synthetic business input', timeZone: 'UTC' };
    await writeFile(identityPath, JSON.stringify(request), { flag: 'wx' }); await sender.submit(request);
    throw new Error('Missing business checkpoint');
  }
  const request = JSON.parse(await readFile(identityPath)), results =
    await Promise.all(Array.from({ length: 10 }, () => sender.submit(request)));
  assert.equal(new Set(results.map(row => row.id)).size, 1);
  assert.ok(results.every(row => row.status === 'recovery_needed' && row.lastConfirmedStep === 'submitting'));
  assert.equal(calls, 0); assert.equal(stores.runs.list().length, 1);
  assert.equal(JSON.parse(await readFile(effectPath)).calls, 1);
  await writeFile(resolve(outputDir, 'recovery.json'), JSON.stringify({ status: 'PASS', pid: process.pid,
    evidenceLevel: 'NPM_RC2_JSON_PROCESS_CONTROLLER_DOUBLE', effects: 1, replayCalls: calls, duplicateRequests: 10,
    lastConfirmedPhase: results[0].lastConfirmedStep, exactlyOnce: false }, null, 2), { flag: 'wx' });
  console.log('DP_B7_DONE');
} finally { await sender.close(); await stores.close(); await ctx.fiber.dispose(); }
