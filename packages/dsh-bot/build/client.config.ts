import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// This build entry runs as native TypeScript in Node; retain bundler-mode types.
const { assertClientInput }: typeof import('./client-policy.js') =
  await import(new URL('./client-policy.ts', import.meta.url).href);
const { cssModules }: typeof import('./css-modules.js') =
  await import(new URL('./css-modules.ts', import.meta.url).href);
const { checkClientThemeTokens }: typeof import('./theme-tokens.js') =
  await import(new URL('./theme-tokens.ts', import.meta.url).href);

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
await checkClientThemeTokens(packageRoot);
const outfile = resolve(packageRoot, 'lib/client.js');
const require = createRequire(import.meta.url);
const schemaEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/schemastery'));
// This public helper is stateless and has no runtime imports. The protocol root
// contains shared service state and is deliberately not an allowed dependency.
const bundledDependencies = new Set([
  await realpath(require.resolve('@deepseek-ai/dsh-typert-protocol/remote-info')),
  // Independent Config validator (no shared resolver extensions); not a platform module.
  await realpath(schemaEntry),
  await realpath(createRequire(schemaEntry).resolve('@deepseek-ai/cosmokit')),
]);

// These are shared entries in the DSH 0.2.1-rc.2 browser module table.
// They must resolve through the factory's require, never a private copy.
const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
];

const result = await build({
  absWorkingDir: packageRoot,
  entryPoints: ['src/client/index.tsx'],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  jsx: 'automatic',
  external,
  plugins: [cssModules()],
  metafile: true,
  write: false,
  // DSH's combo-map route reads the adjacent client.js.map on its first GET.
  sourcemap: 'linked',
  sourcesContent: true,
  legalComments: 'none',
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-bot", factory(require) {\nvar module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports;\n} });' },
});

// Fail the build if a future import accidentally embeds a shared runtime,
// or leaves a require that the platform's injected module table cannot serve.
for (const input of Object.keys(result.metafile.inputs)) {
  const file = input.replace(/^component-css:/, '').replace(/\?inline$/, '');
  assertClientInput(await realpath(resolve(packageRoot, file)), packageRoot, bundledDependencies);
}
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || !external.includes(dependency.path)) {
      throw new Error(`Client bundle requests an unsupported module: ${dependency.path}`);
    }
  }
}

const artifact = result.outputFiles.find((file) => file.path === outfile);
if (!artifact?.text.startsWith('window.__ModuleLoader__.load(')) {
  throw new Error('Client build did not produce a DSH closure-factory artifact');
}
await mkdir(dirname(outfile), { recursive: true });
for (const file of result.outputFiles) {
  await writeFile(file.path, file.contents);
}
console.info(`Built ${outfile} (${artifact.contents.byteLength} bytes; platform modules external)`);
