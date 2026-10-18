import { resolve, sep } from 'node:path';

/** Called with canonical file paths, so symlinks cannot widen the allowlist. */
export function assertClientInput(input: string, packageRoot: string, allowedDependencies: ReadonlySet<string>): void {
  const sourceRoot = `${resolve(packageRoot, 'src')}${sep}`;
  const hostRoot = `${resolve(packageRoot, 'src/host')}${sep}`;
  if (input.startsWith(hostRoot)) throw new Error(`Client bundle contains a Host module: ${input}`);
  if (/(^|[/\\])node_modules([/\\]|$)/.test(input)) {
    if (!allowedDependencies.has(input)) {
      throw new Error(`Client bundle contains an unapproved dependency implementation: ${input}`);
    }
    return;
  }
  if (!input.startsWith(sourceRoot) && !input.startsWith(`${resolve(packageRoot, 'locale')}${sep}`)) {
    throw new Error(`Client bundle contains code outside this package: ${input}`);
  }
}
