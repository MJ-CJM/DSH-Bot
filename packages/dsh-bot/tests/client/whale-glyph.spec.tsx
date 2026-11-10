// @vitest-environment jsdom
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotAvatar } from '../../src/client/components/BotAvatar.js';
import { GroupAvatar } from '../../src/client/components/GroupAvatar.js';
import { WHALE_PATH } from '../../src/client/components/WhaleGlyph.js';
import { BOT_BRAND_PARTS, BOT_BRAND_VIEW_BOX } from '../../src/shared/bot-brand.js';
import { mountClient } from './helpers.js';

describe('Bots navigation brand', () => {
  it('renders the three-whale mark in the registered slot at both host sizes', async () => {
    const app = await mountClient();
    try {
      const entry = app.core.entries('sidebar.panellist').find(({ options }) => options.id === 'dsh-bot');
      if (!entry) throw new Error('Bots navigation slot was not registered');
      const Icon = entry.component as ComponentType<{ size: number }>;
      for (const size of [16, 18]) {
        const markup = renderToStaticMarkup(<Icon size={size} />);
        const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
        expect(svg.getAttribute('width')).toBe(String(size));
        expect(svg.getAttribute('height')).toBe(String(size));
        expect(svg.getAttribute('viewBox')).toBe(BOT_BRAND_VIEW_BOX);
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.getAttribute('data-bot-brand')).toBe('companions');
        expect(svg.getAttribute('fill')).toBe('currentColor');
        expect(svg.querySelector(':not(path)')).toBeNull();
        expect(svg.matches('[color], [stroke], [style]')).toBe(false);
        expect(svg.querySelector('[color], [stroke], [style]')).toBeNull();
        expect(markup).not.toMatch(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\s*\(/i);
        const paths = [...svg.querySelectorAll('path')];
        expect(paths.map((path) => path.getAttribute('data-bot-brand-part'))).toEqual(['glasses', 'sleeping', 'classic']);
        expect(paths.map((path) => path.getAttribute('d'))).toEqual(
          BOT_BRAND_PARTS.map(({ outline, negative, details }) => [outline, negative, details].join(' ')),
        );
        for (const path of paths) {
          expect(path.getAttribute('fill-rule')).toBe('evenodd');
          expect(path.hasAttribute('fill')).toBe(false);
        }
      }
    } finally {
      await app.dispose();
    }
  });
});

it('keeps the classic personal Bot avatar and uses the shared mark for groups without member faces', () => {
  const parser = new DOMParser();
  const bot = parser.parseFromString(renderToStaticMarkup(<BotAvatar bot={{ id: 'alpha-bot' }} />), 'text/html');
  const group = parser.parseFromString(renderToStaticMarkup(<GroupAvatar />), 'text/html');
  expect([...bot.querySelectorAll('svg path')].map((path) => path.getAttribute('d'))).toEqual([WHALE_PATH]);
  expect([...group.querySelectorAll('[data-group-avatar="whales"] path')].map((path) => path.getAttribute('d')))
    .toEqual(BOT_BRAND_PARTS.map(({ outline, negative, details }) => [outline, negative, details].join(' ')));
});
