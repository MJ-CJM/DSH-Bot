import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Maintenance-only generator. Product build/tests read the committed fixture.
const root = process.argv[2];
if (!root) throw new Error('Usage: node build/generate-theme-tokens.mjs <read-only DSH checkout>');
const tag = 'dsh-v0.2.1-rc.2';
const source = 'packages/client/ui-theme/src/styles/design-platform.css';
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', `${tag}^{commit}`);
if (git('rev-parse', 'HEAD') !== commit) throw new Error(`Reference checkout must be at ${tag}`);
const css = readFileSync(resolve(root, source), 'utf8');
const tagged = execFileSync('git', ['-C', root, 'show', `${tag}:${source}`], { encoding: 'utf8' });
if (css !== tagged) throw new Error('Theme file differs from the locked tag');
const definitions = {};
for (const [theme, selector] of [['light', 'body'], ['dark', 'body\\[data-ds-dark-theme\\]']]) {
  const matches = [...css.matchAll(new RegExp(`^${selector} \\{([\\s\\S]*?)^\\}`, 'gm'))];
  if (!matches.length) throw new Error(`Missing ${theme} theme`);
  for (const match of matches) {
    const start = css.slice(0, match.index).split('\n').length;
    for (const [index, line] of match[0].split('\n').entries()) {
      const token = /^\s*(--dsw-alias-[\w-]+)\s*:/.exec(line)?.[1];
      if (token) {
        definitions[token] ??= {};
        definitions[token][`${theme}Line`] = start + index;
      }
    }
  }
}
if (!Object.keys(definitions).length) throw new Error('No alias definitions found');
const tokens = Object.fromEntries(Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)));
const fixture = { tag, commit, source, sha256: createHash('sha256').update(css).digest('hex'), tokens };
writeFileSync(new URL('../tests/fixtures/dsh-theme-tokens-0.2.1-rc.2.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Generated ${Object.keys(tokens).length} aliases from ${tag} (${commit})`);
