// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilitiesPanel, type CapabilityKey } from '../../src/client/components/CapabilitiesPanel.js';
import type { ModelActions } from '../../src/client/model-catalog-state.js';
import { botCreateSchema, botSchema } from '../../src/shared/schema.js';
import baseLocales from '../../../../docs/implementation/capabilities-locales.json';
import platformLocales from '../../../../docs/implementation/platform-locales.json';
import recoveryLocales from '../../../../docs/implementation/conversation-recovery-locales.json';
const locales = { en: { ...baseLocales.en, ...platformLocales.en, ...recoveryLocales.en }, zh: { ...baseLocales.zh, ...platformLocales.zh, ...recoveryLocales.zh } };
const mounted: { root: Root; element: HTMLDivElement }[] = [];
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove(); } });
const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), schemaVersion: 1, createdAt: 1, updatedAt: 1 });
async function mount(language: 'en' | 'zh') {
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element); mounted.push({ root, element });
  const inspect = vi.fn(async () => ({ kind: 'inspect', mainSessionId: 'old-main', dataFlow: { state: 'restricted', reasons: ['no-egress'] },
    online: false, skillsAvailable: false, skills: [], ownSkills: ['review'], tools: [], extraDirs: ['/configured'] }));
  const readSkill = vi.fn(async () => ({ kind: 'skill', name: 'review', hash: 'original', content: 'Saved instructions' }));
  const writeSkill = vi.fn(async () => { throw new Error('conflict'); });
  const freshConversation = vi.fn(async () => 'new-main');
  const openConversation = vi.fn();
  const actions = { inspect, readSkill, writeSkill, freshConversation, openConversation } as unknown as ModelActions;
  const t = (key: CapabilityKey) => locales[language][key];
  await act(async () => root.render(<CapabilitiesPanel bot={bot} actions={actions} t={t} />));
  const click = async (key: CapabilityKey, rootNode: ParentNode = element) => { const label = t(key); const button = [...rootNode.querySelectorAll('button')].find(item => item.textContent === label); if (!button) throw new Error(label); await act(async () => button.click()); };
  const confirmModal = async (action: 'fresh' | 'remove-skill') => {
    const button = element.querySelector<HTMLButtonElement>(`dialog [data-capability-confirm="${action}"]`);
    if (!button) throw new Error(`Missing confirmation button for ${action}`);
    await act(async () => button.click());
  };
  const cancelModal = async () => {
    const dialog = element.querySelector('dialog');
    if (!dialog) throw new Error('Missing confirmation dialog');
    const button = [...dialog.querySelectorAll('button')].find(item => item.textContent === t('capabilities.cancel'));
    if (!button) throw new Error('Missing cancel button');
    await act(async () => button.click());
  };
  return { element, root, t, actions, inspect, readSkill, writeSkill, freshConversation, openConversation, click, confirmModal, cancelModal };
}
describe('capability panel explicit skill actions', () => {
  it.each(['en', 'zh'] as const)('requires explicit recovery confirmation and keeps the skill draft after CAS failure in %s', async language => {
    const f = await mount(language);
    expect(f.element.querySelector('details')?.open).toBe(false);
    expect(f.element.textContent).toContain(f.t('capabilities.flowRestricted'));
    expect(f.freshConversation).not.toHaveBeenCalled();
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      await f.click('capabilities.freshConversation');
      expect(confirmation).not.toHaveBeenCalled();
      expect(f.element.querySelector('dialog')?.textContent).toContain(f.t('capabilities.freshConfirm'));
      await f.cancelModal();
      expect(f.element.querySelector('dialog')).toBeNull();
      expect(f.freshConversation).not.toHaveBeenCalled();
      await f.click('capabilities.edit');
      const textarea = f.element.querySelector('textarea'); if (!textarea) throw new Error('Missing editor');
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Recovery must keep this draft');
        textarea.dispatchEvent(new Event('input', { bubbles: true })); });
      f.freshConversation.mockRejectedValueOnce(new Error('CAS conflict'));
      await f.click('capabilities.freshConversation');
      await f.confirmModal('fresh');
      expect(f.freshConversation).toHaveBeenCalledWith(bot, 'old-main');
      expect(textarea.value).toBe('Recovery must keep this draft');
      expect(f.element.textContent).toContain(f.t('capabilities.freshError'));
      expect(f.inspect).toHaveBeenCalledTimes(1);
      await f.click('capabilities.freshConversation');
      await f.confirmModal('fresh');
      expect(f.freshConversation).toHaveBeenCalledTimes(2);
      expect(f.openConversation).toHaveBeenCalledExactlyOnceWith('new-main');
      expect(f.inspect).toHaveBeenCalledTimes(2);
      expect(f.element.textContent).not.toContain(f.t('capabilities.freshError'));
      expect(textarea.value).toBe('Recovery must keep this draft');
      expect(confirmation).not.toHaveBeenCalled();
    } finally { confirmation.mockRestore(); }
  });

  it.each(['switch', 'unmount'] as const)('does not navigate on a late recovery receipt after %s', async scope => {
    const f = await mount('en');
    let settle!: (sessionId: string) => void;
    f.freshConversation.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
    await f.click('capabilities.freshConversation');
    await f.confirmModal('fresh');
    if (scope === 'switch') await act(async () => f.root.render(<CapabilitiesPanel
      bot={{ ...bot, id: 'beta', createdAt: 2 }} actions={f.actions} t={f.t} />));
    else {
      await act(async () => f.root.unmount());
      mounted.splice(mounted.findIndex(row => row.root === f.root), 1); f.element.remove();
    }
    const reads = f.inspect.mock.calls.length;
    await act(async () => settle('late-main'));
    expect(f.openConversation).not.toHaveBeenCalled();
    expect(f.inspect).toHaveBeenCalledTimes(reads);
  });

  it('catalog refresh of the same Bot preserves the skill draft; late reads cannot replace a new Bot', async () => {
    const f = await mount('en'); await f.click('capabilities.edit');
    const textarea = f.element.querySelector('textarea'); if (!textarea) throw new Error('Missing editor');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Draft remains'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => f.root.render(<CapabilitiesPanel bot={{ ...bot, updatedAt: 2 }} actions={f.actions} t={f.t} />));
    expect(f.element.querySelector('textarea')?.value).toBe('Draft remains');
    let finish!: (value: Awaited<ReturnType<typeof f.readSkill>>) => void;
    f.readSkill.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const button = [...f.element.querySelectorAll('button')].find(item => item.textContent === f.t('capabilities.edit'));
    await act(async () => { button?.click(); });
    await act(async () => f.root.render(<CapabilitiesPanel bot={{ ...bot, id: 'beta', createdAt: 2 }} actions={f.actions} t={f.t} />));
    await act(async () => finish({ kind: 'skill', name: 'review', hash: 'old', content: 'Old Bot leaked content' }));
    expect(f.element.querySelector('textarea')).toBeNull();
    expect(f.element.textContent).not.toContain('Old Bot leaked content');
  });

  it.each(['en', 'zh'] as const)('distinguishes configured/offline and preserves a rejected skill draft in %s', async language => {
    const f = await mount(language);
    expect(f.element.textContent).toContain(f.t('capabilities.offline'));
    expect(f.element.textContent).toContain('/configured');
    expect(f.element.textContent).toContain(f.t('capabilities.unavailable'));
    await f.click('capabilities.edit'); const textarea = f.element.querySelector('textarea'); if (!textarea) throw new Error('Missing editor');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Unsaved draft');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => f.element.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(f.writeSkill).toHaveBeenCalledWith(bot, 'review', 'Unsaved draft', 'original');
    expect(textarea.value).toBe('Unsaved draft'); expect(f.element.querySelector('[role=alert]')?.textContent).toContain(f.t('capabilities.error'));
  });
});

import en from '../../locale/en.json';
import { BotEditor } from '../../src/client/components/BotEditor.js';
const translate = ((key: keyof typeof en.ui) => en.ui[key]) as Parameters<typeof BotEditor>[0]['t'];
async function editor(model?: { provider: string; model: string; reasoningEffort?: string }) {
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element); mounted.push({ root, element });
  const onSave = vi.fn(async () => {});
  const models = { catalog: { getSnapshot: () => ({ providers: [{ id: 'mock', name: 'Mock', available: true, models: [{ provider: 'mock', id: 'small', name: 'Small' }] }] }),
    observe: () => () => {} }, modelInfo: vi.fn(async () => ({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } })) } as unknown as ModelActions;
  await act(async () => root.render(<BotEditor bot={{ ...bot, ...(model ? { model } : {}) }} models={models} onSave={onSave} onCancel={() => {}} t={translate} />));
  return { element, onSave };
}
describe('Bot editor model catalog', () => {
  it('keeps an existing model outside the catalog and its reasoning when saving unrelated settings', async () => {
    const f = await editor({ provider: 'legacy', model: 'custom-route', reasoningEffort: 'special' });
    expect(f.element.textContent).toContain('custom-route');
    await act(async () => f.element.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(f.onSave).toHaveBeenCalledExactlyOnceWith({});
  });
  it('selects the loaded exact provider/model and clears obsolete reasoning only on explicit selection', async () => {
    const f = await editor({ provider: 'legacy', model: 'custom-route', reasoningEffort: 'special' });
    const selector = [...f.element.querySelectorAll('select')].find(select => [...select.options].some(option => option.textContent === 'Small'));
    if (!selector) throw new Error('Missing model selector');
    await act(async () => { selector.value = JSON.stringify(['mock', 'small']); selector.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => f.element.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(f.onSave).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: 'mock', model: 'small' } }));
  });
});
