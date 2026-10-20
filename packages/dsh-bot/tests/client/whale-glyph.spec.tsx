// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotAvatar } from '../../src/client/components/BotAvatar.js';
import { WhaleGlyph } from '../../src/client/components/WhaleGlyph.js';
import { mountClient } from './helpers.js';

describe('shared whale glyph', () => {
  it('registers the shared glyph in the Bots navigation slot at the owner size', async () => {
    const app = await mountClient();
    try {
      const entry = app.core.entries('sidebar.panellist').find(({ options }) => options.id === 'dsh-bot');
      expect(entry).toBeDefined();
      const Icon = entry?.component as ComponentType<{ size: number }>;
      for (const size of [16, 18]) {
        expect(renderToStaticMarkup(<Icon size={size} />)).toBe(renderToStaticMarkup(<WhaleGlyph size={size} />));
      }
    } finally { await app.dispose(); }
  });

  it.each([16, 18])('inherits theme color in the %ipx navigation seat without a background', (size) => {
    const markup = renderToStaticMarkup(<WhaleGlyph size={size} />);
    const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    expect(svg.getAttribute('width')).toBe(String(size));
    expect(svg.getAttribute('height')).toBe(String(size));
    expect(svg.getAttribute('viewBox')).toBe('-0.42 -3.48 24 24');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelector('rect,image,style')).toBeNull();
    expect(markup).not.toMatch(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\s*\(/i);
    expect([...svg.querySelectorAll('[fill],[stroke]')].map((node) => node.getAttribute('fill'))).toEqual(['currentColor']);
  });

  it('reuses the package silhouette in both navigation and default Bot avatars', () => {
    const packageIcon = new DOMParser().parseFromString(readFileSync('icon.svg', 'utf8'), 'image/svg+xml');
    const navigation = new DOMParser().parseFromString(renderToStaticMarkup(<WhaleGlyph />), 'image/svg+xml');
    const avatar = new DOMParser().parseFromString(renderToStaticMarkup(<BotAvatar bot={{ id: 'alpha-bot' }} />), 'text/html');
    const expected = packageIcon.querySelector('path')?.getAttribute('d');
    expect(expected).toBeTruthy();
    expect(navigation.querySelector('path')?.getAttribute('d')).toBe(expected);
    expect(avatar.querySelector('path')?.getAttribute('d')).toBe(expected);
  });
});
