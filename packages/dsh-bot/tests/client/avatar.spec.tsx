// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { avatarColors, BotAvatar, defaultAvatarColor } from '../../src/client/components/BotAvatar.js';
import { BotEditor, type BotEditorProps } from '../../src/client/components/BotEditor.js';
import { AVATAR_COLOR_TOKENS } from '../../src/shared/schema.js';
import { bot, button, click, field, fill, submit } from './helpers.js';
import palette from '../fixtures/avatar-palette-0.2.1-rc.2.json';

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
function translate(language: 'en' | 'zh'): BotEditorProps['t'] {
  const dictionary: Record<string, string> = language === 'zh' ? zh.ui : en.ui;
  return (key, params) => {
    const value = dictionary[key];
    if (value === undefined) throw new Error(`Missing locale ${key}`);
    return value.replace(/\{(\w+)\}/g, (_match, name: string) => String((params as Record<string, unknown> | undefined)?.[name] ?? `{${name}}`));
  };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe('shared Bot avatars', () => {
  it('keeps every palette glyph above 3:1 against its base surface in both locked themes', () => {
    const luminance = (rgb: number[]) => rgb.map((value) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
    for (const theme of [palette.light, palette.dark]) {
      for (const token of AVATAR_COLOR_TOKENS) {
        const weight = Number(avatarColors[token].color.match(/\) (\d+)%/u)?.[1]) / 100;
        expect(weight).toBeGreaterThan(0);
        const color = theme.colors[token].map((value, i) => value * weight + (theme.foreground[i] ?? 0) * (1 - weight));
        const a = luminance(color);
        const b = luminance(theme.background);
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('assigns deterministic palette colors from identity across renders, locales and themes', async () => {
    const original = bot();
    const color = defaultAvatarColor(original.id);
    expect(AVATAR_COLOR_TOKENS).toContain(color);
    expect(new Set(['aa', 'ab', 'ac', 'ad'].map(defaultAvatarColor)).size).toBe(4);
    const app = await mount(<BotAvatar bot={original} label="Avatar" />);
    expect(app.container.querySelector('[data-bot-avatar="whale"]')?.getAttribute('data-avatar-color')).toBe(color);
    document.body.setAttribute('data-ds-dark-theme', '');
    await app.render(<BotAvatar bot={{ ...original, id: original.id }} label="头像" />);
    expect(app.container.querySelector('[data-bot-avatar="whale"]')?.getAttribute('data-avatar-color')).toBe(color);
    expect(app.container.querySelector('svg')).not.toBeNull();
    document.body.removeAttribute('data-ds-dark-theme');
  });

  it('prefers an uploaded raster image, then an explicit emoji, then a colored whale', async () => {
    const original = bot({ id: 'alpha-bot', name: 'Alpha', avatarColor: '--dsw-alias-state-success-primary' });
    const app = await mount(<BotAvatar bot={{ ...original, avatar: 'data:image/png;base64,aGVsbG8=' }} />);
    expect(app.container.querySelector('[data-bot-avatar="image"] img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(app.container.querySelector('svg')).toBeNull();
    await app.render(<BotAvatar bot={{ ...original, avatar: '🧠' }} />);
    expect(app.container.querySelector('[data-bot-avatar="emoji"]')?.textContent).toBe('🧠');
    expect(app.container.querySelector('img,svg')).toBeNull();
    await app.render(<BotAvatar bot={original} />);
    expect(app.container.querySelector('[data-bot-avatar="whale"]')?.getAttribute('data-avatar-color')).toBe(original.avatarColor);
  });

  it.each(['en', 'zh'] as const)('previews and saves an explicit color, then clears it to automatic (%s)', async (language) => {
    const dictionary = language === 'zh' ? zh.ui : en.ui;
    const onSave = vi.fn<BotEditorProps['onSave']>();
    const app = await mount(<BotEditor bot={bot({ id: 'alpha-bot', name: 'Alpha', avatar: '🦊' })} onSave={onSave} onCancel={() => {}} t={translate(language)} />);
    const swatch = app.container.querySelector<HTMLButtonElement>(`button[aria-label="${dictionary['avatar.green']}"]`);
    if (!swatch) throw new Error('No color swatch');
    await click(swatch);
    const preview = app.container.querySelector(`[aria-label="${dictionary['avatar.current']}"]`);
    expect(preview?.getAttribute('data-bot-avatar')).toBe('whale');
    expect(preview?.getAttribute('data-avatar-color')).toBe('--dsw-alias-state-success-primary');
    await submit(app.container);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ avatar: null, avatarColor: '--dsw-alias-state-success-primary' }));
    await click(button(app.container, dictionary['avatar.automatic']));
    await submit(app.container);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ avatar: null, avatarColor: null }));
  });

  it('saves a new color without introducing a required color into legacy/default records', async () => {
    const onSave = vi.fn<BotEditorProps['onSave']>();
    const app = await mount(<BotEditor onSave={onSave} onCancel={() => {}} t={translate('en')} />);
    await fill(field(app.container, en.ui['editor.name']), 'New Bot');
    await fill(field(app.container, en.ui['editor.id']), 'new-bot');
    await submit(app.container);
    expect(onSave.mock.calls[0]?.[0].avatarColor).toBeUndefined();
    const swatch = app.container.querySelector<HTMLButtonElement>(`button[aria-label="${en.ui['avatar.red']}"]`);
    if (!swatch) throw new Error('No color swatch');
    await click(swatch);
    await submit(app.container);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'new-bot', avatarColor: '--dsw-alias-state-error-primary' }));
  });

  it('uploads a validated raster image in the secondary controls and rejects unsupported files', async () => {
    const onSave = vi.fn<BotEditorProps['onSave']>();
    const app = await mount(<BotEditor bot={bot({ id: 'alpha-bot', name: 'Alpha', avatar: '🦊' })} onSave={onSave} onCancel={() => {}} t={translate('en')} />);
    const upload = app.container.querySelector<HTMLInputElement>('details input[type="file"]');
    if (!upload) throw new Error('No secondary image input');
    const choose = async (file: File) => {
      Object.defineProperty(upload, 'files', { configurable: true, value: [file] });
      await act(async () => { upload.dispatchEvent(new Event('change', { bubbles: true })); });
    };
    await choose(new File(['unsafe'], 'image.svg', { type: 'image/svg+xml' }));
    expect(app.container.textContent).toContain(en.ui['validation.avatar']);
    expect(app.container.querySelector(`[aria-label="${en.ui['avatar.current']}"]`)?.getAttribute('data-bot-avatar')).toBe('emoji');
    await act(async () => {
      await choose(new File(['raster'], 'image.png', { type: 'image/png' }));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(app.container.querySelector(`[aria-label="${en.ui['avatar.current']}"]`)?.getAttribute('data-bot-avatar')).toBe('image');
    await submit(app.container);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ avatar: 'data:image/png;base64,cmFzdGVy' }));
  });
});
