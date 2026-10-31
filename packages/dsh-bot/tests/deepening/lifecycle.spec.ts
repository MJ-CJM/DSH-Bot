import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { openBotStores } from '../../src/host/store.js';
import { acquireMemoryOwner } from '../../src/host/memory/owner-lease.js';
import { v2Fixture } from './v2-fixtures.js';

describe('I13 owner lifecycle', () => {
  it('refuses a live writer in another process and reacquires after clean release', async () => {
    const f = await v2Fixture();
    try {
      const path = join(f.root, 'data', 'memory-owner');
      await expect(acquireMemoryOwner(path)).rejects.toThrow('alive');
      const url = pathToFileURL(resolve('lib/host/memory/owner-lease.js')).href;
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import {acquireMemoryOwner} from ${JSON.stringify(url)};try {await acquireMemoryOwner(${JSON.stringify(path)});process.exit(2)}
        catch(e){if(!String(e).includes('alive')){console.error(e);process.exit(3)}}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      const code = await new Promise(resolve => child.on('close', resolve)); expect(code).toBe(0);
      await f.reopen(); expect(f.kernel.frozen).toBe(false);
    } finally { await f.close(); }
  });
  it('rejects symlink directory traversal before acquiring or opening a domain', async () => {
    const f = await v2Fixture();
    try {
      await symlink(join(f.root, 'data'), join(f.root, 'redirect'));
      await expect(acquireMemoryOwner(join(f.root, 'redirect', 'owner'))).rejects.toThrow('symlinks');
    } finally { await f.close(); }
  });
  it('recovers only a confirmed dead local owner and makes concurrent successors compete on the same path', async () => {
    const f = await v2Fixture();
    const url = pathToFileURL(resolve('lib/host/memory/owner-lease.js')).href;
    const path = join(f.root, 'abandoned');
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {acquireMemoryOwner} from ${JSON.stringify(url)};await acquireMemoryOwner(${JSON.stringify(path)});
      console.log('OWNER_READY');setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = new Promise(resolve => child.on('close', resolve));
    try {
      await new Promise<void>((accept, reject) => {
        let output = ''; const timeout = setTimeout(() => reject(new Error('Child owner timeout')), 5000);
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('OWNER_READY')) { clearTimeout(timeout); accept(); } });
        child.once('error', reject);
      });
      child.kill('SIGKILL'); await done;
      const results = await Promise.allSettled([acquireMemoryOwner(path), acquireMemoryOwner(path)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) if (result.status === 'fulfilled') {
        result.value.assertOwner(); await Promise.all([result.value.close(), result.value.close()]);
      }
    } finally { child.kill('SIGKILL'); await done; await f.close(); }
  });
  it('joins 20 actual Cordis effect unloads and releases the owner before every reload', async () => {
    // 20 durable fsync/open/unload cycles need an explicit I/O budget under concurrent workers.
    // This test needs a directory, not another migrated kernel and two seeded Bots.
    const base = resolve('../../.dsh-dev/deepening'); await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'effect-cycle-')), ctx = new Context(), dataDir = join(root, 'data');
    try {
      await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root: join(root, 'storage') }).await();
      await ctx.plugin(storageDomain, { backend: 'json' }).await();
      let scope: string | undefined;
      for (let cycle = 0; cycle < 20; cycle++) {
        let stores: Awaited<ReturnType<typeof openBotStores>> | undefined;
        const fork = ctx.plugin({ inject: ['storageDomain'], async apply(owner) {
          stores = await openBotStores(owner, { memoryV2: { dataDir } });
        } });
        await fork.await();
        if (!stores?.memoryKernel) throw new Error('Effect did not open memory');
        const id = stores.memoryKernel.scope.scope.id;
        if (scope) expect(id).toBe(scope); else scope = id;
        await fork.dispose(); expect(ctx.storageDomain.get('dsh_bot_memory')).toBeUndefined();
        const lease = await acquireMemoryOwner(join(dataDir, 'memory-owner')); await lease.close();
      }
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
  }, 30000);
});
