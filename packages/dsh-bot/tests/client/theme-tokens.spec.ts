import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertThemeTokens, checkClientThemeTokens } from '../../build/theme-tokens.js';
import fixture from '../fixtures/dsh-theme-tokens-0.2.1-rc.2.json';

describe('locked DSH theme tokens', () => {
  const allowed = new Set(Object.keys(fixture.tokens));
  it('checks all Client CSS/TSX against the committed rc.2 fixture without reading the reference checkout', async () => {
    expect(fixture.tag).toBe('dsh-v0.2.1-rc.2');
    expect(fixture.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const definition of Object.values(fixture.tokens)) {
      expect(definition.lightLine).toBeGreaterThan(0);
      expect(definition.darkLine).toBeGreaterThan(0);
    }
    await checkClientThemeTokens(fileURLToPath(new URL('../../', import.meta.url)));
  });
  it('rejects nonexistent tokens, even when a CSS fallback would hide the typo', () => {
    expect(() => assertThemeTokens('color: var(--dsw-alias-made-up, inherit)', allowed, 'bad.module.css'))
      .toThrow('bad.module.css: unknown DSH rc.2 theme token --dsw-alias-made-up');
    expect(() => assertThemeTokens('color: "var( --dsw-alias-label-primary )"', allowed, 'good.tsx')).not.toThrow();
  });
});
