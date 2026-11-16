import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Build from the reviewed adapter source; only write inside this repository. */
export async function buildBotModeAdapter({ runtime = resolve(root, '.dsh-dev/proactive-bot/host-runtime'), output = resolve(root, '.dsh-dev/bot-mode-adapter/package') } = {}) {
  assert.ok(resolve(output).startsWith(`${root}/.dsh-dev/`), 'Adapter output must stay in repository .dsh-dev');
  const cliRequire = createRequire(resolve(runtime, 'package.json'));
  const cliPath = cliRequire.resolve('@deepseek-ai/dsh/package.json');
  const nativeRequire = createRequire(cliPath);
  const sourcePackage = dirname(nativeRequire.resolve('@deepseek-ai/dsh-client-shortcuts/package.json'));
  const manifest = JSON.parse(await readFile(resolve(sourcePackage, 'package.json')));
  assert.equal(manifest.version, '0.2.1-rc.2');
  await mkdir(output, { recursive: true });
  await cp(sourcePackage, output, { recursive: true, dereference: true });
  await cp(resolve(root, 'adapters/bot-mode-shortcuts/src'), resolve(output, 'src'), { recursive: true });
  const esbuildPath = (await readdir(resolve(root, 'node_modules/.pnpm'))).find(name => name === 'esbuild@0.28.2');
  assert.ok(esbuildPath, 'Use the locked workspace esbuild');
  const { build } = await import(pathToFileURL(resolve(root, 'node_modules/.pnpm', esbuildPath, 'node_modules/esbuild/lib/main.js')));
  const marker = 'DSH_BOT_COMMAND_MODE_ADAPTER_RC2_V1';
  await build({ entryPoints: [resolve(output, 'src/client/index.ts')], outfile: resolve(output, 'lib/client.js'), bundle: true,
    format: 'cjs', platform: 'browser', target: 'es2024', nodePaths: [resolve(dirname(sourcePackage), '..')],
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives'],
    banner: { js: `/* ${marker} */\nwindow.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-shortcuts", factory(require) { var module = { exports: {} }; var exports = module.exports;` },
    footer: { js: 'return module.exports; } });' },
  });
  // Keep the public /client types in sync with the new runtime contract.
  const types = await readFile(resolve(root, 'adapters/bot-mode-shortcuts/src/client/types.ts'), 'utf8');
  await writeFile(resolve(output, 'lib/types/client/types.d.ts'), types.replaceAll(".ts'", ".js'"));
  const entry = resolve(output, 'lib/types/client/index.d.ts');
  const declaration = (await readFile(entry, 'utf8'))
    .replace(/^export type \{ ShortcutCommandMode, [^\n]+\} from '\.\/types\.js'\n/gm, '')
    .replace(/^ {4}\/\/ DSH_BOT_MODE_PUBLIC_API_BEGIN[\s\S]*?^ {4}\/\/ DSH_BOT_MODE_PUBLIC_API_END\n/gm, '')
    .replace(/^ {4}registerCommandMode\(mode: Parameters<Shortcuts\['registerCommandMode'\]>\[0\]\): ReturnType<Shortcuts\['registerCommandMode'\]>;\n/gm, '');
  const methods = `    // DSH_BOT_MODE_PUBLIC_API_BEGIN
    readonly modePresentation: Shortcuts['modePresentation'];
    readonly commandModeSurfaces: Shortcuts['commandModeSurfaces'];
    registerCommandModeSurface(surface: 'chat.branch' | 'workspace.blank-preset'): () => void;
    resolveCommandMode(...args: Parameters<Shortcuts['resolveCommandMode']>): ReturnType<Shortcuts['resolveCommandMode']>;
    registerCommandMode(mode: Parameters<Shortcuts['registerCommandMode']>[0]): ReturnType<Shortcuts['registerCommandMode']>;
    // DSH_BOT_MODE_PUBLIC_API_END
`;
  await writeFile(entry, `export type { ShortcutCommandMode, ShortcutCommandModeHandle, ShortcutResolution, ShortcutModePresentation } from './types.js'\n${declaration.replace('    registerFixed(', `${methods}    registerFixed(`)}`);
  const client = await readFile(resolve(output, 'lib/client.js'));
  // The original isolated runtime is an immutable baseline even when callers
  // rebuild from a copy that already carries this adapter.
  const baselineCli = createRequire(resolve(root, '.dsh-dev/proactive-bot/host-runtime/package.json')).resolve('@deepseek-ai/dsh/package.json');
  const baselinePackage = dirname(createRequire(baselineCli).resolve('@deepseek-ai/dsh-client-shortcuts/package.json'));
  const upstreamClient = await readFile(resolve(baselinePackage, 'lib/client.js'));
  assert.ok(!upstreamClient.toString().includes(marker), 'Original runtime baseline was unexpectedly adapted');
  const sourceDigests = {};
  for (const file of ['types.ts', 'registry.ts', 'index.ts']) sourceDigests[`src/client/${file}`] = sha256(await readFile(resolve(root, 'adapters/bot-mode-shortcuts/src/client', file)));
  const receipt = { baseline: manifest.version, marker, package: output, originalPackage: await realpath(baselinePackage),
    originalClientSha256: sha256(upstreamClient), sha256: sha256(client), bytes: client.length, sourceDigests,
    sourceTag: 'dsh-v0.2.1-rc.2', sourceCommit: '687f282e8625c6b8d11ff58211a90524be2e4317', scope: 'Repository-local independent approval host only' };
  await writeFile(resolve(output, 'adapter-manifest.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildBotModeAdapter(), null, 2));
