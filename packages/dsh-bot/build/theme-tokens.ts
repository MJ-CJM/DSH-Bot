import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function assertThemeTokens(source: string, allowed: ReadonlySet<string>, filename: string): void {
  for (const match of source.matchAll(/var\(\s*(--dsw-alias-[\w-]+)/g)) {
    const token = match[1];
    if (token && !allowed.has(token)) throw new Error(`${filename}: unknown DSH rc.2 theme token ${token}`);
  }
}

/** Check every Client source, including CSS/TSX not currently reachable by bundling. */
export async function checkClientThemeTokens(packageRoot: string): Promise<void> {
  const fixture = JSON.parse(await readFile(join(packageRoot, 'tests/fixtures/dsh-theme-tokens-0.2.1-rc.2.json'), 'utf8'));
  const allowed = new Set<string>(Object.keys(fixture.tokens));
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:css|tsx?)$/.test(entry.name)) assertThemeTokens(await readFile(path, 'utf8'), allowed, path);
    }
  }
  await visit(join(packageRoot, 'src/client'));
}
