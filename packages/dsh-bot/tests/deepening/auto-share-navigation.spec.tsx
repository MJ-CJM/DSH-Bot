// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { bot, button, click, mountClient } from '../client/helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

it.each(['en', 'zh'] as const)('opens the capability panel from Management and reopens saved policy (%s, DOM only)', async language => {
  let app = await mountClient([bot()], language);
  const t = language === 'en' ? en.ui : zh.ui;
  const panel = () => app.container.querySelector(`aside[aria-label="${t['autoShare.title']}"]`);
  const requiredPanel = () => { const element = panel(); if (!element) throw new Error('Missing capability panel'); return element; };
  try {
    await click(button(app.container, t['manage.title']));
    await click(button(app.container, t['manage.memoryTools']));
    // The real MemoryPanel initially selects legacy/private entries, just like the failed browser artifact.
    expect(panel()).toBeNull();
    expect(app.remote.methods.memory.autoShareStatus).not.toHaveBeenCalled();
    await click(button(app.container, t['shared.scope.shared']));
    expect(panel()?.textContent).toContain(t['autoShare.unavailable']);
    expect(panel()?.textContent).toContain(t['autoShare.egressBlocked']);
    await click(button(requiredPanel(), t['autoShare.disable']));
    expect(button(requiredPanel(), t['autoShare.enable'])).toBeDefined();
    // Recreate the entire Client, preserving only the Remote double's saved policy. Not a browser reload proof.
    const policy = app.remote.methods.memory;
    await app.dispose();
    app = await mountClient([bot()], language, remote => {
      remote.methods.memory.autoShareStatus = policy.autoShareStatus;
      remote.methods.memory.setAutoShare = policy.setAutoShare;
    });
    await click(button(app.container, t['manage.title']));
    await click(button(app.container, t['manage.memoryTools']));
    expect(panel()).toBeNull();
    await click(button(app.container, t['shared.scope.shared']));
    expect(button(requiredPanel(), t['autoShare.enable'])).toBeDefined();
    expect(app.remote.methods.memory.autoShareStatus).toHaveBeenCalledTimes(2);
    expect(app.remote.methods.memory.setAutoShare).toHaveBeenCalledTimes(1);
  } finally { await app.dispose(); }
});
