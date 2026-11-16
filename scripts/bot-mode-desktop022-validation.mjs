import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openArchive, sha256 } from '../adapters/bot-mode-desktop022/archive.mjs';

const root = process.cwd(), base = resolve(root, '.dsh-dev/bot-mode-desktop022');
const prepared = JSON.parse(await readFile(resolve(base, 'prepare.json')));
const instance = prepared.instance, home = resolve(instance, 'home'), profile = resolve(home, 'profiles/desktop');
const artifact = resolve(process.env.DSH_BOT_DESKTOP_ARTIFACT ?? '.dsh-dev/bot-mode-redesign/run-eWFZpF/candidate-e/dsh-bot-0.6.6.tgz');
assert.ok(artifact.startsWith(`${root}/.dsh-dev/`));
assert.equal(sha256(await readFile(artifact)), process.env.DSH_BOT_DESKTOP_ARTIFACT_SHA256 ?? '0826e00dccf7cd090490c7ef9c6bf469fa6bb1f0fddc2d0f083a1050976951c2');
const env = { PATH: process.env.PATH, SHELL: process.env.SHELL,
  DSH_HOME: home, DSH_AGENTS_HOME: resolve(instance, 'agents'), XDG_STATE_HOME: resolve(instance, 'state'),
  XDG_DATA_HOME: resolve(instance, 'data'), XDG_CACHE_HOME: resolve(instance, 'cache'), XDG_CONFIG_HOME: resolve(instance, 'config'),
  NODE_COMPILE_CACHE: resolve(instance, 'node-cache'), TMPDIR: resolve(instance, 'tmp'), DSH_TELEMETRY_DISABLED: '1',
  DSH_BOT_DSH_BIN: resolve(prepared.isolated, 'Contents/Resources/runtime/cli/bin/dsh'),
  pnpm_config_store_dir: resolve(root, '.dsh-dev/pnpm-store'), pnpm_config_cache_dir: resolve(root, '.dsh-dev/pnpm-cache'), pnpm_config_offline: 'true',
  DP_MOCK_PORT: '0', DP_NETWORK_RECEIPT: resolve(base, 'network-denials.jsonl') };
for (const key of ['DSH_HOME','DSH_AGENTS_HOME','XDG_STATE_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_CONFIG_HOME','TMPDIR']) await mkdir(env[key], { recursive: true });
const command = (args, name) => {
  try { const output = execFileSync(resolve(root, 'scripts/dsh'), args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); return output; }
  catch (error) { throw new Error(`${name}: ${String(error.stderr ?? error).replace(/([?&]token=)[^\s]+/g,'$1[redacted]')}`); }
};
const [action = 'start'] = process.argv.slice(2);
if (action === 'stop') {
  const state = JSON.parse(await readFile(resolve(base, 'validation-service.json')));
  const args = execFileSync('/bin/ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' });
  assert.ok(args.includes(prepared.isolated) && args.includes(prepared.flag));
  process.kill(state.pid, 'SIGTERM');
  console.log(JSON.stringify({ stopped: state.pid }));
} else {
  assert.equal(action, 'start');
  assert.equal(command(['--version'], 'version').trim(), '0.2.2-rc.2');
  if (!await readFile(resolve(profile, 'package.json')).then(() => true, () => false)) {
    command(['--profile','validation-stage','--from-default-profile','web','--dump-config'], 'initialize');
    command(['plugin','--profile','validation-stage','add',artifact], 'install');
    await cp(resolve(home, 'profiles/validation-stage'), profile, { recursive: true });
  } else {
    const installed = JSON.parse(await readFile(resolve(profile, 'package.json'), 'utf8'));
    if (installed.dependencies?.['dsh-bot'] !== `file:${artifact}`)
      command(['plugin','--profile','desktop','add',artifact], 'update-validation-artifact');
  }
  const frozen = (await readFile(resolve(root, 'scripts/bot-mode-approval-profile.mjs'), 'utf8'))
    .replace("import './deepening/network-guard.mjs';", "import './network-guard.mjs';")
    .replace("createRequire(new URL('../packages/dsh-bot/package.json', import.meta.url))", `createRequire(${JSON.stringify(resolve(root,'packages/dsh-bot/package.json'))})`);
  await writeFile(resolve(base, 'fixture.mjs'), frozen);
  await cp(resolve(root, 'scripts/deepening/network-guard.mjs'), resolve(base, 'network-guard.mjs'));
  const patch = [
    '- id: storage-json','  config:',`    root: ${JSON.stringify(resolve(instance,'storage'))}`,
    '- id: session-persistence-jsonl','  config:',`    root: ${JSON.stringify(resolve(instance,'sessions'))}`,
    '- id: credentials-local','  config:',`    path: ${JSON.stringify(resolve(instance,'credentials.yml'))}`,'    watch: false',
    '- id: dsh-bot','  config:','    seedExamples: false',`    dataDir: ${JSON.stringify(resolve(instance,'bots'))}`,
    '    supergroup:','      enabled: true','      maxRequests: 24','      timeoutMs: 300000',
    '- id: agent-default-model','  config:','    provider: bot-mode-local','    model: review',
    ...['llm-deepseek','llm-deepseek-account','llm-pi-ai','session-title-llm','llm-retry','session-log-deepseek','session-telemetry-otel','desktop-product-telemetry'].flatMap(id => [`- id: ${id}`,'  disabled: true']),
    '- insert:','    - id: bot-mode-desktop022-fixture',`      name: ${JSON.stringify(resolve(base,'fixture.mjs'))}`,
    '      config:',`        outputDir: ${JSON.stringify(base)}`,`        installedRoot: ${JSON.stringify(resolve(profile,'node_modules/dsh-bot'))}`,
  ].join('\n');
  await writeFile(resolve(profile, 'cordis.patch.yml'), `${patch}\n`);
  const net = await import('node:net'); const reservation = net.createServer();
  await new Promise(accept => reservation.listen(0,'127.0.0.1',accept));
  const port = reservation.address().port; await new Promise(accept => reservation.close(accept));
  const executable = resolve(prepared.isolated, 'Contents/MacOS/DeepSeek Harness');
  const log = await open(resolve(base,'validation-main.log'),'w',0o600);
  const child = spawn(executable, [prepared.flag,`--remote-debugging-port=${port}`,`--user-data-dir=${resolve(instance,'userData')}`], { cwd: root, env, detached: true, stdio:['ignore',log.fd,log.fd] });
  child.unref(); await log.close();
  const state = { pid: child.pid, executable, home, cdpEndpoint:`http://127.0.0.1:${port}`, launchedAt:new Date().toISOString() };
  await writeFile(resolve(base,'validation-service.json'), JSON.stringify(state,null,2));
  const deadline=Date.now()+120000;let ready=false;
  while(Date.now()<deadline){
    const output=await readFile(resolve(base,'validation-main.log'),'utf8');
    if(output.includes('BOT_MODE_APPROVAL_FAILED'))throw new Error('Synthetic desktop fixture failed; see fixture-error.json');
    if(output.includes('BOT_MODE_APPROVAL_READY')){ready=true;break;}
    process.kill(child.pid,0);await delay(200);
  }
  assert.ok(ready,'Current native Host did not become ready; never reuse an earlier fixture receipt');
  const fixture=JSON.parse(await readFile(resolve(base,'fixture.json')));
  const resources=JSON.parse(await readFile(resolve(base,'client-provenance.json')));
  const image=openArchive(await readFile(resolve(prepared.isolated,'Contents/Resources/app.asar')));
  for(const [id,resource]of Object.entries(resources)){
    const bytes=id==='dsh-bot'?await readFile(resource.path):image.read(resource.path.split('/app.asar/')[1]);
    assert.equal(sha256(bytes),resource.sha256);
    const path=resolve(base,'served-bytes',`${id.replaceAll('/','_')}.js`);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes);
    resource.installedPath=resource.path;resource.path=path;
  }
  const config={...state,mode:'isolated',botId:'local-assistant',botName:'通用助手',sessionId:fixture.sessions['local-assistant'],artifact:{path:artifact,sha256:sha256(await readFile(artifact))},provenance:resources,fixtureDir:base};
  await writeFile(resolve(base,'smoke-isolated.json'),JSON.stringify(config,null,2),{mode:0o600});
  console.log(JSON.stringify({status:'PASS',...state,smokeConfig:resolve(base,'smoke-isolated.json')}));
}
