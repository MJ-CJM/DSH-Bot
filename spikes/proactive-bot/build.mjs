import { readdir, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
async function entries(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await entries(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) result.push(path);
  }
  return result;
}
await mkdir(join(root, 'lib'), { recursive: true });
await build({
  entryPoints: await entries(join(root, 'src')),
  outbase: join(root, 'src'),
  outdir: join(root, 'lib'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
});
