// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupMessage } from '../../src/shared/groups.js';
import { expect, it } from 'vitest';
import { GroupMessageCard } from '../../src/client/components/GroupTimeline.js';
import { view } from './group-fixture.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

const parameters = JSON.stringify({ botId: 'expert', question: 'Review the shared text.' });
async function mount(language: 'en' | 'zh', overrides: Partial<GroupMessage> = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('main'), root = createRoot(element);
  const message: GroupMessage = { ...view().messages[0], id: 'tool-request', seq: 1, at: 1, turnId: 'turn',
    authorKind: 'bot', text: parameters, stopReason: 'expert-request', causeId: 'expert-request:checked-digest', ...overrides };
  const t = ((key: keyof typeof en.ui) => (language === 'en' ? en : zh).ui[key]) as PropsLocale<'dsh-bot'>['t'];
  await act(async () => root.render(<GroupMessageCard message={message} t={t}
    labels={{ code: { copyLabel: 'copy', copiedLabel: 'copied' }, footnotes: 'footnotes' }}
    onReply={() => {}} onOpenAttachment={async () => {}} onOpenSession={async () => {}} />));
  return { element, t, async close() { await act(async () => root.unmount()); } };
}

it.each(['en', 'zh'] as const)('%s expert tool request is folded by metadata and preserves its exact parameters', async language => {
  const f = await mount(language);
  try {
    const details = f.element.querySelector<HTMLDetailsElement>('[data-group-expert-request="tool-request"]');
    expect(details).toBeTruthy(); expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe(f.t('groups.expertRequest'));
    expect(details?.querySelector('pre code')?.textContent).toBe(parameters);
    expect(f.element.textContent).toContain('Original beta');
    expect(f.element.querySelector('[data-bot-id="beta"]')).toBeTruthy();
    if (!details) throw new Error('Missing process disclosure');
    await act(async () => { details.open = true; });
    expect(details.open).toBe(true);
  } finally { await f.close(); }
});

it.each([
  { authorKind: 'user' as const },
  { authorKind: 'proactive' as const },
  { stopReason: undefined },
  { causeId: undefined },
  { causeId: 'ordinary-message' },
])('keeps ordinary JSON visible unless the Bot execution metadata matches: %o', async overrides => {
  const f = await mount('en', overrides);
  try {
    expect(f.element.querySelector('[data-group-expert-request]')).toBeNull();
    expect(f.element.textContent).toContain(parameters);
    expect(f.element.querySelector('details')).toBeNull();
  } finally { await f.close(); }
});
