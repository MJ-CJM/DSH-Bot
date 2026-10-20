// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
import { bot, mountClient } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); });

describe('activity navigation supersession', () => {
  it.each(['panel', 'session', 'unload'] as const)('does not navigate a late markRead after %s changes', async (change) => {
    const app = await mountClient([bot()]); cleanups.push(app.dispose);
    const actions = app.main.inject?.() as unknown as BotsPageInjected;
    let finish!: () => void;
    const original = app.remote.methods.activity.markRead.getMockImplementation();
    if (!original) throw new Error('Missing activity double');
    app.remote.methods.activity.markRead.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return original(...args);
    });
    const pending = actions.onOpenSession('old-session');
    expect(app.openSession).not.toHaveBeenCalled();
    if (change === 'panel') app.selectPanel('dsh-bot' as never);
    if (change === 'session') app.openSession('new-session' as never);
    if (change === 'unload') await app.unloadPlugin();
    await act(async () => { finish(); await pending; });
    expect(app.openSession.mock.calls.map(([id]) => id)).toEqual(change === 'session' ? ['new-session'] : []);
  });

  it('opens old or evicted sessions after activity/not-found without blocking history', async () => {
    const app = await mountClient([bot()]); cleanups.push(app.dispose);
    const actions = app.main.inject?.() as unknown as BotsPageInjected;
    await act(async () => actions.onOpenSession('old-session'));
    expect(app.remote.methods.activity.markRead).toHaveBeenCalledExactlyOnceWith('old-session');
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('old-session');
    expect(app.remote.methods.activity.markRead.mock.invocationCallOrder[0]).toBeLessThan(app.openSession.mock.invocationCallOrder[0] ?? 0);
  });
});
