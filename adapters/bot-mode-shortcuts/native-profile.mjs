import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd(), base = resolve(root, '.dsh-dev/bot-mode-native');
const prepared = JSON.parse(await readFile(resolve(base, 'prepare.json')));
const instance = prepared.instance, home = resolve(instance, 'home'), profile = resolve(home, 'profiles/desktop');
const env = { PATH: process.env.PATH, USER: 'synthetic', SHELL: '/bin/zsh', HOME: resolve(instance, 'environment-home'), TMPDIR: resolve(instance, 'tmp'),
 DSH_HOME: home, DSH_AGENTS_HOME: resolve(instance, 'agents'), XDG_STATE_HOME: resolve(instance, 'state'), DSH_TELEMETRY_DISABLED: '1',
 DSH_BOT_DSH_BIN: resolve(prepared.copied, 'Contents/Resources/runtime/cli/bin/dsh'), pnpm_config_offline: 'true',
 pnpm_config_store_dir: resolve(root, '.dsh-dev/pnpm-store'), pnpm_config_cache_dir: resolve(root, '.dsh-dev/pnpm-cache') };
for (const path of [env.HOME, env.TMPDIR, home]) await mkdir(path, { recursive: true });
const commands = [];
const cli = (args, label) => { const output=execFileSync(resolve(root,'scripts/dsh'),args,{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}); commands.push({args,label});return output; };
assert.equal(cli(['--version'],'version').trim(),'0.2.2-rc.2');
if (!process.argv.includes('--patch-only')) {
 cli(['--profile','native-stage','--from-default-profile','web','--dump-config'],'initialize');
 const artifact = JSON.parse(await readFile(resolve(root,'.dsh-dev/bot-mode-approval/service.json'))).artifact;
 cli(['plugin','--profile','native-stage','add',artifact],'install-frozen-product');
 await cp(resolve(home,'profiles/native-stage'),profile,{recursive:true});
}
const adapterRoot=resolve(base,'adapter-host'); await mkdir(adapterRoot,{recursive:true});
await cp(resolve(root,'.dsh-dev/bot-mode-adapter/package'),adapterRoot,{recursive:true});
// Supply this isolated Host-half's public package dependencies through its own profile mapping.
await mkdir(resolve(adapterRoot,'node_modules'),{recursive:true});
const { symlink } = await import('node:fs/promises');
for(const id of ['@deepseek-ai/schemastery','@deepseek-ai/cordis','@deepseek-ai/dsh-util-crypto','@deepseek-ai/dsh-util-values']){
 const destination=resolve(adapterRoot,'node_modules',id);await mkdir(resolve(destination,'..'),{recursive:true});
 try{await symlink(resolve(root,'node_modules/.pnpm/node_modules',id),destination,'dir')}catch(e){if(e.code!=='EEXIST')throw e}
}
const patch=[
 '- id: storage-json','  config:',`    root: ${JSON.stringify(resolve(instance,'storage'))}`,
 '- id: session-persistence-jsonl','  config:',`    root: ${JSON.stringify(resolve(instance,'sessions'))}`,
 '- id: credentials-local','  config:',`    path: ${JSON.stringify(resolve(instance,'credentials.yml'))}`,'    watch: false',
 '- id: dsh-bot','  config:','    seedExamples: false',`    dataDir: ${JSON.stringify(resolve(instance,'bots'))}`,
 '- id: agent-default-model','  config:','    provider: dp-loopback','    model: fixture',
 ...['llm-deepseek','llm-deepseek-account','llm-pi-ai','session-title-llm','llm-retry','session-log-deepseek','session-telemetry-otel','desktop-product-telemetry'].flatMap(id=>[`- id: ${id}`,'  disabled: true']),
 '- insert:','    - id: bot-mode-native-probe',`      name: ${JSON.stringify(resolve(root,'adapters/bot-mode-shortcuts/probe/host.mjs'))}`,
 '      config:',`        outputDir: ${JSON.stringify(base)}`,`        expectedShortcutsPath: ${JSON.stringify(prepared.adapterClientPath)}`,
].join('\n');
await writeFile(resolve(profile,'cordis.patch.yml'),`${patch}\n`);
await writeFile(resolve(base,'launch-environment.json'),JSON.stringify(env,null,2));
await writeFile(resolve(base,'profile-commands.json'),JSON.stringify(commands,null,2));
console.log(JSON.stringify({profile,adapterRoot,launcher:prepared.launcher,environment:resolve(base,'launch-environment.json'),launched:false},null,2));
