import { expect, it } from 'vitest';
import { unavailableBotMain } from '../../src/client/bot-main-guard.js';
import { bot } from './helpers.js';
import type { BotCatalogEntry } from '../../src/client/state.js';

it('pauses only a persisted Bot main with missing identity and leaves native approvals in control', () => {
  const entry: BotCatalogEntry = { bot: bot(), status: { id: 'alpha-bot', presetId: 'bot-alpha-bot',
    preset: { state: 'ok' }, boundMainSessionId: 'held-main', mainSessionState: 'unavailable' } };
  const check = (sessionId: string, preset?: string, pendingInteraction?: never) =>
    unavailableBotMain({ sessionId: sessionId as never, pendingInteraction }, [entry], preset);
  expect(check('held-main', 'standard')).toEqual({ botId: 'alpha-bot' });
  expect(check('held-main')).toEqual({ botId: 'alpha-bot' });
  expect(check('unrelated-main', 'standard')).toBeNull();
  expect(check('held-main', 'standard', { kind: 'approval' } as never)).toBeNull();
  entry.status!.mainSessionState = 'ready';
  expect(check('held-main', 'bot-alpha-bot')).toBeNull();
  expect(check('held-main', 'standard')).toEqual({ botId: 'alpha-bot' });
});
