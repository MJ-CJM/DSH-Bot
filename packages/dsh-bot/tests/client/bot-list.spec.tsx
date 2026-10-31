// @vitest-environment jsdom
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { BotList, type BotListProps } from '../../src/client/components/BotList.js';
import { ACTIVITY_HIDDEN_PREVIEW } from '../../src/shared/activity.js';
import { bot, click } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
async function mount(node: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: ReactNode) => { await act(async () => { root.render(next); }); };
  await render(node);
  cleanups.push(async () => { await act(async () => { root.unmount(); }); container.remove(); });
  return { container, render };
}
function translate(language: 'en' | 'zh'): BotListProps['t'] {
  const dictionary: Record<string, string> = language === 'zh' ? zh.ui : en.ui;
  return (key, params) => {
    const value = dictionary[key];
    if (value === undefined) throw new Error(`Missing locale ${key}`);
    return value.replace(/\{(\w+)\}/g, (_match, name: string) => String((params as Record<string, unknown> | undefined)?.[name] ?? `{${name}}`));
  };
}
async function key(element: HTMLElement, value: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); });
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('shared compact Bot list', () => {
  it.each(['en', 'zh'] as const)('retains localized preview, unread and relative time in compact rows (%s)', async (language) => {
    const dictionary = language === 'zh' ? zh.ui : en.ui;
    const at = Date.now() - 60_000;
    const entries = [{ bot: bot() }, { bot: bot({ id: 'beta-bot', name: 'Beta', description: 'Bot description' }) },
      { bot: bot({ id: 'gamma-bot', name: 'Gamma', description: '' }) }];
    const props: BotListProps = { entries, t: translate(language), compact: true, onSelect: vi.fn(), onActivate: vi.fn(),
      activities: [{ botId: 'alpha-bot', lastActivityAt: at, unreadCount: 3,
        latest: { sessionId: 'session-one', role: 'assistant', preview: ACTIVITY_HIDDEN_PREVIEW, at } }] };
    const app = await mount(<BotList {...props} />);
    const rows = app.container.querySelectorAll<HTMLElement>('[role="option"]');
    expect(rows[0]?.querySelector<HTMLElement>('[data-bot-avatar]')?.style.width).toBe('32px');
    expect(rows[0]?.querySelector('[data-activity-preview]')?.textContent).toBe(dictionary['activity.hidden']);
    expect(rows[0]?.querySelector('[data-unread]')?.getAttribute('aria-label')).toBe(dictionary['activity.unreadCount'].replace('{count}', '3'));
    expect(rows[0]?.querySelector('time')?.textContent).toBe(new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' }).format(-1, 'minute'));
    expect(rows[1]?.querySelector('[data-activity-preview]')?.textContent).toBe('Bot description');
    expect(rows[2]?.querySelector('[data-activity-preview]')?.textContent).toBe(dictionary['bots.noSessions']);
    expect(rows[1]?.querySelector('[data-unread]')).toBeNull();
    await app.render(<BotList {...props} compact={false} />);
    expect(app.container.querySelector<HTMLElement>('[data-bot-avatar]')?.style.width).toBe('40px');
  });

  it('separates arrow selection from activation and keeps selected identity through a reordered snapshot', async () => {
    const onActivate = vi.fn<BotListProps['onActivate']>();
    const entries = [{ bot: bot() }, { bot: bot({ id: 'beta-bot', name: 'Beta' }) }];
    function Controlled({ reverse = false }: { reverse?: boolean }) {
      const [selectedId, select] = useState('alpha-bot');
      return <BotList entries={reverse ? [...entries].reverse() : entries} activities={[]} t={translate('en')}
        selectedId={selectedId} onSelect={select} onActivate={onActivate} compact />;
    }
    const app = await mount(<Controlled />);
    const list = app.container.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error('Bot list is missing');
    list.focus();
    await key(list, 'ArrowDown');
    expect(app.container.querySelector('[aria-selected="true"]')?.getAttribute('data-bot-id')).toBe('beta-bot');
    expect(onActivate).not.toHaveBeenCalled();
    await app.render(<Controlled reverse />);
    expect(app.container.querySelector('[aria-selected="true"]')?.getAttribute('data-bot-id')).toBe('beta-bot');
    expect(list.getAttribute('aria-activedescendant')).toBe(app.container.querySelector('[aria-selected="true"]')?.id);
    await key(list, 'Enter');
    expect(onActivate).toHaveBeenLastCalledWith('beta-bot');
    await key(list, 'End');
    await key(list, ' ');
    expect(onActivate).toHaveBeenLastCalledWith('alpha-bot');
    expect(document.activeElement).toBe(list);
  });

  it('selects on click, activates on double click, restores focus and blocks disabled activation', async () => {
    const calls: string[] = [];
    const props: BotListProps = { entries: [{ bot: bot() }], activities: [], t: translate('en'), compact: true,
      onSelect: (id) => { calls.push(`select:${id}`); }, onActivate: (id) => { calls.push(`activate:${id}`); } };
    const app = await mount(<BotList {...props} />);
    const option = app.container.querySelector<HTMLButtonElement>('[role="option"]');
    const list = app.container.querySelector<HTMLElement>('[role="listbox"]');
    if (!option || !list) throw new Error('Bot list is missing');
    await click(option);
    expect(calls).toEqual(['select:alpha-bot']);
    await act(async () => { option.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(calls).toEqual(['select:alpha-bot', 'activate:alpha-bot']);
    expect(document.activeElement).toBe(list);
    await app.render(<BotList {...props} disabled />);
    expect(option.disabled).toBe(true);
    expect(list.getAttribute('aria-disabled')).toBe('true');
    await click(option);
    await key(list, 'Enter');
    await key(list, 'ArrowDown');
    expect(calls).toHaveLength(2);
  });
});
