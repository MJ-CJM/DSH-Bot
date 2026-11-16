// Orchestrator-only daily upgrade, explicitly authorized by the user's target
// selection. Stop the app gracefully before backup/install; never stop a PID by name.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile, chmod, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { openArchive, sha256 } from '../adapters/bot-mode-desktop022/archive.mjs';
import { auditArtifact, auditInstalled } from './p34-artifact.mjs';

const root = process.cwd(), base = resolve(root, '.dsh-dev/bot-mode-desktop022');
const app = '/Applications/DeepSeek Harness.app', home = resolve(homedir(), '.dsh');
const userData = resolve(homedir(), 'Library/Application Support/@deepseek-ai/dsh-desktop');
const yaml = createRequire(resolve(root,'packages/dsh-bot/package.json'))('js-yaml');
const prepared = JSON.parse(await readFile(resolve(base,'prepare.json')));
const action = process.argv[2];
assert.notEqual(action, 'install', 'Retired: this legacy installer replaces the official signature with ad-hoc signing. Use deploy-official-desktop.mjs and install-official-desktop-compat.mjs.');
const artifact = resolve(process.argv[3] ?? '.dsh-dev/bot-mode-redesign/run-eWFZpF/candidate-e/dsh-bot-0.6.6.tgz');
assert.ok(artifact.startsWith(`${root}/.dsh-dev/`));
const assertStopped = () => {
  const lines=execFileSync('/bin/ps',['-Ao','pid,command'],{encoding:'utf8'}).split('\n');
  assert.ok(!lines.some(line=>line.trim().replace(/^\d+\s+/,'').startsWith(`${app}/Contents/MacOS/DeepSeek Harness`)), 'Quit the daily application gracefully before upgrade');
};
async function files(folder) {
  const result=[];
  for(const row of await readdir(folder,{withFileTypes:true})){
    const path=resolve(folder,row.name);
    if(row.isDirectory())result.push(...await files(path));
    else if(row.isFile())result.push(path);
  }
  return result;
}
if(action==='backup'){
  assertStopped();
  assert.equal(sha256(await readFile(resolve(app,'Contents/Resources/app.asar'))),prepared.originalArchiveSha256);
  const rollback=resolve(base,`rollback-${Date.now()}`);await mkdir(rollback,{mode:0o700});
  await cp(home,resolve(rollback,'dsh-home'),{recursive:true,verbatimSymlinks:true});
  await cp(userData,resolve(rollback,'desktop-userData'),{recursive:true,verbatimSymlinks:true});
  execFileSync('/bin/cp',['-cR',app,resolve(rollback,'DeepSeek Harness.app')]);
  const data=[];
  for(const path of await files(home)){
    if(path.startsWith(resolve(home,'profiles')+'/'))continue;
    const bytes=await readFile(path);data.push({path:path.slice(home.length+1),sha256:sha256(bytes),bytes:bytes.length});
  }
  const bot=JSON.parse(await readFile(resolve(home,'storages/dsh_bot.json')));
  const bindings=JSON.parse(await readFile(resolve(home,'storages/dsh_bot_main_session.json')));
  const receipt={status:'PASS',rollback,home,userData,originalArchiveSha256:prepared.originalArchiveSha256,data,
    bots:bot.tables.bots,memories:bot.tables.memories,bindings:bindings.tables.bindings,createdAt:new Date().toISOString()};
  await writeFile(resolve(base,'daily-backup.json'),JSON.stringify(receipt,null,2),{mode:0o600});
  await chmod(resolve(base,'daily-backup.json'),0o600);
  console.log(JSON.stringify({status:'PASS',rollback,dataFiles:data.length,bots:Object.keys(receipt.bots).length,bindings:Object.keys(receipt.bindings).length}));
}else if(action==='install'){
  assertStopped();
  const backup=JSON.parse(await readFile(resolve(base,'daily-backup.json')));
  assert.equal(backup.originalArchiveSha256,prepared.originalArchiveSha256);
  const manifest=await auditArtifact(root,artifact,resolve(base,'daily-artifact-audit'));
  const env={...process.env,DSH_HOME:home,DSH_BOT_DSH_BIN:resolve(app,'Contents/Resources/runtime/cli/bin/dsh'),
    XDG_STATE_HOME:resolve(base,'install-state'),XDG_CACHE_HOME:resolve(base,'install-cache'),
    NODE_COMPILE_CACHE:resolve(base,'install-node-cache'),TMPDIR:resolve(base,'install-tmp'),
    pnpm_config_store_dir:resolve(root,'.dsh-dev/pnpm-store'),pnpm_config_cache_dir:resolve(root,'.dsh-dev/pnpm-cache'),pnpm_config_offline:'true'};
  await mkdir(env.TMPDIR,{recursive:true});
  try{
    const output=execFileSync(resolve(root,'scripts/dsh'),['plugin','--profile','desktop','add',artifact],{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    await writeFile(resolve(base,'daily-install.log'),output);
  }catch(error){await writeFile(resolve(base,'daily-install.log'),`${error.stdout??''}\n${error.stderr??''}`);throw new Error('Daily plugin installation failed; inspect private log and restore cold backup if necessary');}
  const patchFile=resolve(home,'profiles/desktop/cordis.patch.yml'),patch=yaml.load(await readFile(patchFile,'utf8'));
  assert.ok(Array.isArray(patch));const bot=patch.find(row=>row.id==='dsh-bot');assert.ok(bot);
  const beforeConfig=structuredClone(patch);bot.config??={};bot.config.supergroup={...(bot.config.supergroup??{}),enabled:true};
  const withoutSwitch=value=>{const rows=structuredClone(value);const row=rows.find(item=>item.id==='dsh-bot');if(row.config?.supergroup){delete row.config.supergroup.enabled;if(!Object.keys(row.config.supergroup).length)delete row.config.supergroup;}if(row.config&&!Object.keys(row.config).length)delete row.config;return rows;};
  assert.deepEqual(withoutSwitch(patch),withoutSwitch(beforeConfig),'Only the approved Supergroup switch changes existing Host settings');
  await writeFile(patchFile,yaml.dump(patch,{lineWidth:-1}));
  const installed=await auditInstalled(home,'desktop',manifest);
  for(const row of backup.data)assert.equal(sha256(await readFile(resolve(home,row.path))),row.sha256,`Cold user data changed during install: ${row.path}`);
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',prepared.production],{stdio:'pipe'});
  assert.equal(sha256(await readFile(resolve(prepared.production,'Contents/Resources/app.asar'))),prepared.productionArchiveSha256);
  const stage=`${app}.dsh-bot-staged`;await cp(prepared.production,stage,{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false});
  const previous=resolve(backup.rollback,'daily-app-before-swap.app');
  await rename(app,previous);
  try{await rename(stage,app);}catch(error){await rename(previous,app);throw error;}
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'pipe'});
  const archive=openArchive(await readFile(resolve(app,'Contents/Resources/app.asar')));
  const provenance={};
  for(const [id,row]of Object.entries(prepared.adapted)){
    const bytes=archive.read(row.archivePath);assert.equal(sha256(bytes),row.sha256);
    provenance[id]={path:row.path,sha256:row.sha256,installedPath:resolve(app,'Contents/Resources/app.asar',row.archivePath)};
  }
  const renderer=archive.read(prepared.originalRenderer.archivePath),rendererPath=resolve(base,'clients/original-renderer.js');
  assert.equal(sha256(renderer),prepared.originalRenderer.sha256);await writeFile(rendererPath,renderer);
  provenance['@deepseek-ai/dsh-client-ui-renderer']={path:rendererPath,sha256:sha256(renderer)};
  const productPath=resolve(home,'profiles/desktop/node_modules/dsh-bot/lib/client.js');
  provenance['dsh-bot']={path:productPath,sha256:sha256(await readFile(productPath))};
  await writeFile(resolve(base,'daily-provenance.json'),JSON.stringify(provenance,null,2));
  const receipt={status:'PASS',artifact,artifactSha256:manifest.sha256,installed,appArchiveSha256:prepared.productionArchiveSha256,
    rollback:backup.rollback,coldDataFilesPreserved:backup.data.length,supergroupEnabled:true,otherHostSettingsPreserved:true};
  await writeFile(resolve(base,'daily-installed.json'),JSON.stringify(receipt,null,2),{mode:0o600});
  console.log(JSON.stringify({status:'PASS',artifactSha256:manifest.sha256,coldDataFilesPreserved:backup.data.length,supergroupEnabled:true,rollback:backup.rollback}));
}else throw new Error('Usage: node scripts/deploy-bot-mode-desktop022.mjs backup | install [frozen tgz]');
