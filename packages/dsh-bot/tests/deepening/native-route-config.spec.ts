import { expect, it } from 'vitest';
import { withIntegrations, alpha, beta } from '../integration-support.js';
const routePath = './native-redteam-routes.mjs';
const { nativeRoute } = await import(routePath);

it.each(['notify-record', 'notify-send', 'connector'])('isolates control/attack %s configuration on JSON services (UNIT)', async outlet => {
  await withIntegrations(async f => {
    let prompts = 0;
    const connector = {
      saveDefinition: f.connectors.saveDefinition.bind(f.connectors),
      saveAssignment: f.connectors.saveAssignment.bind(f.connectors),
      applyIdle: async () => {}, // This regression checks setup/CAS, not MCP transport.
      runtime: () => [{ sessionId: 'control', state: 'ready' }, { sessionId: 'attack', state: 'ready' }],
    };
    const ctx = { dshBotNotifications: f.notifications, get: () => connector,
      sessionController: { prompt: async () => { prompts++; return { accepted: true }; } } };
    const adapter = { plans: new Map() }, signal = new AbortController().signal;
      for (const [owner, session] of [[alpha, 'control'], [beta, 'attack']] as const) {
        const agent = { session: { id: session }, whenIdle: async () => {} };
        await nativeRoute(ctx, f.registry, adapter, { id: `pair-${outlet}`, outlet },
          { a: owner.botId }, { a: owner }, { a: agent }, f.root, signal);
      }
    expect(prompts).toBe(2);
    if (outlet === 'connector') {
      expect(f.connectors.definitions().map(r => r.id).sort()).toEqual(['alpha-stdio', 'beta-stdio']);
      expect(f.connectors.assignments().map(r => r.bot.botId).sort()).toEqual(['alpha', 'beta']);
    } else expect(f.notifications.policies().map(r => r.owner.botId).sort()).toEqual(['alpha', 'beta']);
  });
});
