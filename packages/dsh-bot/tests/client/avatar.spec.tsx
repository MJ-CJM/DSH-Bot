// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { getByRole } from '@testing-library/dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { avatarColors, BotAvatar, defaultAvatarColor, defaultAvatarVariant, resolvedAvatarVariant } from '../../src/client/components/BotAvatar.js';
import { BotEditor, type BotEditorProps } from '../../src/client/components/BotEditor.js';
import { WhaleGlyph } from '../../src/client/components/WhaleGlyph.js';
import { AVATAR_COLOR_TOKENS, AVATAR_VARIANTS, botSchema } from '../../src/shared/schema.js';
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
        // Evaluate the actual CSS expression, including nested sRGB mixtures.
        const resolveColor = (expression: string): number[] => {
          const variable = expression.match(/^var\((--[\w-]+)\)$/u)?.[1];
          if (variable) {
            if (variable === '--dsw-alias-label-primary') return theme.foreground;
            const value = theme.colors[variable as keyof typeof theme.colors];
            if (!value) throw new Error(`Unknown palette fixture ${variable}`);
            return value;
          }
          const parts = expression.match(/^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/u);
          if (!parts) throw new Error(`Unexpected color ${expression}`);
          const a = resolveColor(parts[1] ?? '');
          const b = resolveColor(parts[3] ?? '');
          const weight = Number(parts[2]) / 100;
          return a.map((value, i) => value * weight + (b[i] ?? 0) * (1 - weight));
        };
        const color = resolveColor(avatarColors[token].color);
        const a = luminance(color);
        const b = luminance(theme.background);
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('parses legacy records without migration and defaults them to classic', () => {
    const old = bot({ id: 'legacy-bot', name: 'Legacy', avatarColor: '--dsw-alias-state-success-primary' });
    expect(botSchema.parse(old)).toEqual(old);
    expect(botSchema.parse(old)).not.toHaveProperty('avatarVariant');
    expect(resolvedAvatarVariant(old)).toBe('classic');
    for (const variant of [...AVATAR_VARIANTS, 'auto']) {
      expect(botSchema.parse({ ...old, avatarVariant: variant }).avatarVariant).toBe(variant);
    }
    expect(botSchema.safeParse({ ...old, avatarVariant: 'unknown' }).success).toBe(false);
  });

  it('distributes automatic shapes and colors independently and preserves identity', async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `bot-${index}`);
    expect(new Set(ids.map(defaultAvatarVariant)).size).toBe(6);
    expect(new Set(ids.map(defaultAvatarColor)).size).toBe(12);
    expect(new Set(ids.map((id) => `${defaultAvatarVariant(id)}:${defaultAvatarColor(id)}`)).size).toBeGreaterThan(24);
    expect(defaultAvatarVariant('bot-42')).toBe('classic');
    expect(defaultAvatarColor('bot-42')).toBe('slate');
    const original = bot({ id: 'bot-42', name: 'Auto', avatarVariant: 'auto' });
    const app = await mount(<BotAvatar bot={original} label="Avatar" />);
    const expected = app.container.querySelector('[data-bot-avatar]')?.getAttribute('data-avatar-variant');
    expect(expected).toBe(defaultAvatarVariant(original.id));
    document.body.setAttribute('data-ds-dark-theme', '');
    await app.render(<BotAvatar bot={{ ...original }} label="头像" />);
    expect(app.container.querySelector('[data-bot-avatar]')?.getAttribute('data-avatar-variant')).toBe(expected);
    document.body.removeAttribute('data-ds-dark-theme');
  });

  it.each(AVATAR_VARIANTS)('renders %s with currentColor only', (variant) => {
    const markup = renderToStaticMarkup(<WhaleGlyph variant={variant} />);
    const svg = new DOMParser().parseFromString(markup, 'image/svg+xml');
    expect(svg.querySelector('image,style,foreignObject')).toBeNull();
    expect(markup).not.toMatch(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\s*\(/i);
    for (const node of svg.querySelectorAll('[fill],[stroke]')) {
      for (const attr of ['fill', 'stroke']) if (node.hasAttribute(attr)) expect(['currentColor', 'none']).toContain(node.getAttribute(attr));
    }
  });

  it.each(['en', 'zh'] as const)('selects shapes and colors with keyboard, saves, and restores automatic (%s)', async (language) => {
    const dictionary = language === 'zh' ? zh.ui : en.ui;
    const onSave = vi.fn<BotEditorProps['onSave']>();
    const app = await mount(<BotEditor bot={bot()} onSave={onSave} onCancel={() => {}} t={translate(language)} />);
    const shapes = getByRole(app.container, 'group', { name: dictionary['avatar.variant'] });
    const classic = getByRole(shapes, 'button', { name: dictionary['avatar.variant.classic'] });
    const key = async (element: HTMLElement, key: string) => {
      element.focus();
      await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })); });
    };
    await key(classic, 'ArrowRight');
    const glasses = getByRole(shapes, 'button', { name: dictionary['avatar.variant.glasses'] });
    expect(document.activeElement).toBe(glasses);
    expect(glasses.getAttribute('aria-pressed')).toBe('true');
    const colors = getByRole(app.container, 'group', { name: dictionary['avatar.color'] });
    expect(colors.querySelectorAll('button')).toHaveLength(12);
    await key(getByRole(colors, 'button', { name: dictionary['avatar.blue'] }), 'End');
    expect(document.activeElement).toBe(getByRole(colors, 'button', { name: dictionary['avatar.slate'] }));
    await submit(app.container);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ avatarVariant: 'glasses', avatarColor: 'slate' }));
    await key(glasses, 'Home');
    await key(classic, 'ArrowLeft');
    await submit(app.container);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ avatarVariant: 'sleeping', avatarColor: 'slate' }));
    await click(button(app.container, dictionary['avatar.automatic']));
    await submit(app.container);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ avatarVariant: 'auto', avatarColor: null }));
    await app.render(<BotEditor bot={bot()} busy onSave={onSave} onCancel={() => {}} t={translate(language)} />);
    expect(app.container.querySelector('fieldset')?.disabled).toBe(true);
    const calls = onSave.mock.calls.length;
    await key(classic, 'ArrowRight');
    await submit(app.container);
    expect(onSave.mock.calls).toHaveLength(calls);
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
