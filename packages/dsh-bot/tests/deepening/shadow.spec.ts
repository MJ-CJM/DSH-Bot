import { describe, it, expect } from 'vitest';
import { ShadowPlanner, emptyShadow } from '../../src/host/shadow/planner.js';
import { syntheticDue } from '../../src/host/shadow/schedule-adapter.js';
import { startShadow } from '../../src/host/shadow/service.js';
import { Config } from '../../src/host/registry-config.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { policy, shadowFixture } from './shadow-fixture.js';
const at = Date.parse('2026-01-01T12:00:00Z');
const due = (id: string, time = at, relevant = true) => ({ source: 'synthetic' as const, occurrenceId: id,
  owner: { botId: 'alpha', botCreatedAt: 1 }, at: time, relevant });
describe('I65 pure report shadow', () => {
  it('defaults off and exposes no real organizer or model path even when configured', async () => {
    const config = Config({}), planner = new ShadowPlanner(config, emptyShadow(), async () => {});
    expect(config.shadowEnabled).toBe(false); expect(config.offlineOrganizeEnabled).toBe(false);
    expect(await planner.evaluate(due('disabled'), policy())).toMatchObject({ candidate: false, reason: 'disabled' });
    expect(planner.status()).toMatchObject({ opportunities: 0, modelRequests: 0, notifications: 0, memoryWrites: 0 });
    await planner.close(); await expect(planner.evaluate(due('late'), policy())).rejects.toThrow();
    expect(() => Config({ shadowDomainDaily: 1.5 })).toThrow();
  });
  it('scores 100 synthetic opportunities with quiet/duplicate gold and fixed denominator', async () => {
    const planner = new ShadowPlanner(Config({ shadowEnabled: true, shadowDomainDaily: 100, shadowBotDaily: 100 }),
      emptyShadow(), async () => {});
    const p = { ...policy(), dailyLimit: 100, cooldownSec: 0 };
    let tp = 0, fp = 0, fn = 0, quietViolations = 0, duplicates = 0;
    const observations = [];
    // Ten days, each five quiet, two useful, one irrelevant, two duplicate events.
    for (let day = 0; day < 10; day++) for (let slot = 0; slot < 10; slot++) {
      const time = Date.parse(`2026-01-${String(day + 1).padStart(2, '0')}T${slot < 5 ? '03' : '12'}:00:00Z`);
      const duplicate = slot >= 8, relevant = slot === 5 || slot === 6 || duplicate;
      const result = await planner.evaluate(due(`${day}:${duplicate ? 5 : slot}`, time, relevant), p);
      const gold = slot === 5 || slot === 6;
      observations.push({ day, slot, gold, quiet: slot < 5, duplicate, ...result });
      if (result.candidate && gold) tp++; if (result.candidate && !gold) fp++; if (!result.candidate && gold) fn++;
      if (slot < 5 && result.candidate) quietViolations++; if (duplicate && result.candidate) duplicates++;
    }
    expect({ tp, fp, fn, quietViolations, duplicates }).toEqual({ tp: 20, fp: 0, fn: 0, quietViolations: 0, duplicates: 0 });
    expect(planner.status()).toMatchObject({ opportunities: 100, candidates: 20, modelRequests: 0, notifications: 0 });
    const dir = resolve('../../.dsh-dev/deepening/b8'); await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `shadow-${Date.now()}.json`), JSON.stringify({ source: 'synthetic', status: 'PASS', opportunities: 100,
      tp, fp, fn, precision: tp / (tp + fp), recall: tp / (tp + fn), quietViolations, duplicates, state: planner.snapshot(), observations }));
    await planner.close();
  });
  it('enforces global in-app budget, per-bot policy, cooldown, clock monotonicity and durable de-duplication', async () => {
    const config = Config({ shadowEnabled: true, shadowDomainDaily: 1 }); let disk = emptyShadow();
    let planner = new ShadowPlanner(config, disk, async state => { disk = structuredClone(state); });
    expect((await planner.evaluate(due('a'), policy())).candidate).toBe(true);
    expect((await planner.evaluate(due('cooldown', at + 1), policy())).reason).toBe('cooldown');
    await planner.close(); planner = new ShadowPlanner(config, disk, async () => {});
    expect((await planner.evaluate(due('a'), policy())).reason).toBe('duplicate');
    expect((await planner.evaluate(due('backwards', at - 1), policy())).reason).toBe('clock-backward');
    const beta = policy('beta');
    expect((await planner.evaluate({ ...due('b', at + 60000), owner: beta.owner }, beta)).reason).toBe('domain-budget');
    await expect(planner.evaluate(due('wrong-owner'), beta)).rejects.toThrow('owner'); await planner.close();
    const limited = new ShadowPlanner(Config({ shadowEnabled: true, shadowBotDaily: 0 }), emptyShadow(), async () => {});
    expect((await limited.evaluate(due('blocked'), policy())).reason).toBe('bot-budget'); await limited.close();
  });
  it('reuses native scheduledAt identity without creating or running any native schedule', () => {
    const a = syntheticDue('task-a', { scheduledAt: new Date(at).toISOString() },
      { source: 'synthetic', owner: policy().owner, at, relevant: true });
    const b = syntheticDue('task-a', { scheduledAt: '2026-01-01T12:00:00.000Z' },
      { source: 'synthetic', owner: policy().owner, at, relevant: true });
    expect(a.occurrenceId).toBe(b.occurrenceId);
    expect(() => syntheticDue('a', { scheduledAt: 'invalid' }, due('bad'))).toThrow();
  });
  it('releases the actual JSON domain and service on 20 effect unloads and preserves synthetic report counts', async () => {
    const f = await shadowFixture();
    try {
      for (let cycle = 0; cycle < 20; cycle++) {
        const fork = f.ctx.plugin({ inject: ['storageDomain'], async apply(ctx) {
          await startShadow(ctx, Config({ shadowEnabled: true }));
        } }); await fork.await();
        const planner = f.ctx.get('dshBotShadow'); if (!planner) throw Error('Shadow unavailable');
        await planner.evaluate(due('one'), policy()); expect(planner.status().candidates).toBe(1);
        await fork.dispose(); expect(f.ctx.get('dshBotShadow')).toBeUndefined();
        expect(f.ctx.storageDomain.get('dsh_bot_shadow')).toBeUndefined();
        await expect(planner.evaluate(due('unloaded'), policy())).rejects.toThrow();
      }
    } finally { await f.close(); }
  }, 30000);
});
