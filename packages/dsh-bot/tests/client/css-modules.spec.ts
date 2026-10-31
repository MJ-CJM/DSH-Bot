import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import { expect, it } from 'vitest';
import { cssModules } from '../../build/css-modules.js';

it('recompiles changed CSS on a watch rebuild, retaining matching inline styles and class names', async () => {
  const home = fileURLToPath(new URL('../../../../.dsh-dev/', import.meta.url));
  await mkdir(home, { recursive: true });
  const root = await mkdtemp(join(home, 't08-css-rebuild-'));
  const css = join(root, 'sample.module.css');
  const entry = join(root, 'entry.js');
  let builder: Awaited<ReturnType<typeof context>> | undefined;
  try {
    await writeFile(entry, "export { default as classes } from './sample.module.css';\nexport { default as css } from './sample.module.css?inline';\n");
    await writeFile(css, '.sample { color: var(--dsw-alias-label-primary); }');
    builder = await context({ entryPoints: [entry], bundle: true, format: 'cjs', write: false, outdir: join(root, 'out'), plugins: [cssModules()] });
    async function artifact() {
      if (!builder) throw new Error('Builder missing');
      const result = await builder.rebuild();
      const output = result.outputFiles?.find((file) => file.path.endsWith('.js'));
      if (!output) throw new Error('Missing CSS module JS output');
      const module = { exports: {} as { css: string; classes: Record<string, string> } };
      new Function('module', output.text)(module);
      expect(module.exports.css).toContain(`.${module.exports.classes.sample}`);
      return module.exports;
    }
    expect((await artifact()).css).toContain('--dsw-alias-label-primary');
    await writeFile(css, '.sample { color: var(--dsw-alias-label-secondary); }');
    const next = await artifact();
    expect(next.css).toContain('--dsw-alias-label-secondary');
    expect(next.css).not.toContain('--dsw-alias-label-primary');
  } finally {
    await builder?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
