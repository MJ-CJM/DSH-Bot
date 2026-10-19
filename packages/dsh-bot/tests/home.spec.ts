import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BotHomes, validateDefaultCwd } from '../src/host/home.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));
async function facility(run: (root: string, homes: BotHomes) => Promise<void>) {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't08h-home-'));
  try { await run(root, new BotHomes(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe('owned Bot private homes', () => {
  it('creates only on demand, uses 0700, is idempotent and verifies persisted ownership after restart', async () => facility(async (root, homes) => {
    const path = join(root, 'dsh-bot', 'bots', 'alpha', 'home');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await homes.ensure('alpha')).toEqual({ path });
    const before = await stat(path);
    expect(before.mode & 0o777).toBe(0o700);
    await writeFile(join(path, 'note.txt'), 'Kept content');
    await chmod(path, 0o755);
    expect(await new BotHomes(root).ensure('alpha')).toEqual({ path });
    expect((await stat(path)).ino).toBe(before.ino);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(path, 'note.txt'), 'utf8')).toBe('Kept content');
    expect((await stat(join(root, 'dsh-bot', 'bots', 'alpha', '.home-owner.json'))).mode & 0o777).toBe(0o600);
  }));

  it('rejects traversing ids and symlink escapes at every managed directory level', async () => facility(async (root, homes) => {
    for (const id of ['../escape', 'alpha/../beta', 'alpha/home', '/absolute', '..', 'a\\b']) {
      await expect(homes.ensure(id)).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    const outside = join(root, 'outside');
    await mkdir(outside);
    for (const components of [['dsh-bot'], ['dsh-bot', 'bots'], ['dsh-bot', 'bots', 'alpha'], ['dsh-bot', 'bots', 'alpha', 'home']]) {
      await rm(join(root, 'dsh-bot'), { recursive: true, force: true });
      const parent = join(root, ...components.slice(0, -1));
      await mkdir(parent, { recursive: true });
      await symlink(outside, join(root, ...components), 'dir');
      await expect(homes.ensure('alpha')).rejects.toMatchObject({ code: 'bot/invalid' });
      await expect(stat(join(outside, 'home'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }));

  it('does not adopt an existing unmarked home, replaced inode, or symlinked marker', async () => facility(async (root, homes) => {
    const path = join(root, 'dsh-bot', 'bots', 'alpha', 'home');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'user.txt'), 'Never delete');
    await expect(homes.ensure('alpha')).rejects.toMatchObject({ code: 'bot/invalid' });
    await expect(homes.prepareRemoval('alpha')).rejects.toMatchObject({ code: 'bot/invalid' });
    expect(await readFile(join(path, 'user.txt'), 'utf8')).toBe('Never delete');
    const beta = (await homes.ensure('beta')).path;
    await rename(beta, `${beta}-saved`);
    await mkdir(beta);
    await expect(homes.ensure('beta')).rejects.toMatchObject({ code: 'bot/invalid' });
    await expect(homes.prepareRemoval('beta')).rejects.toMatchObject({ code: 'bot/invalid' });
    const gamma = (await homes.ensure('gamma')).path;
    const marker = join(gamma, '..', '.home-owner.json');
    await rename(marker, `${marker}.saved`);
    await symlink(`${marker}.saved`, marker);
    await expect(homes.ensure('gamma')).rejects.toMatchObject({ code: 'bot/invalid' });
  }));

  it('removes only the owned home; child symlinks never delete their targets or sibling skills', async () => facility(async (root, homes) => {
    const home = (await homes.ensure('alpha')).path;
    const user = join(root, 'user-project');
    const skills = join(home, '..', 'skills');
    await mkdir(user); await mkdir(skills);
    await writeFile(join(user, 'keep.txt'), 'User directory');
    await writeFile(join(skills, 'SKILL.md'), 'Sibling skills');
    await symlink(user, join(home, 'outside'), 'dir');
    const remove = await homes.prepareRemoval('alpha');
    await remove();
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(user, 'keep.txt'), 'utf8')).toBe('User directory');
    expect(await readFile(join(skills, 'SKILL.md'), 'utf8')).toBe('Sibling skills');
    expect((await homes.ensure('alpha')).path).toBe(home);
  }));

  it('makes absent-home removal a no-op and rechecks ownership immediately before deletion', async () => facility(async (root, homes) => {
    await (await homes.prepareRemoval('absent'))();
    await expect(stat(join(root, 'dsh-bot'))).rejects.toMatchObject({ code: 'ENOENT' });
    const home = (await homes.ensure('alpha')).path;
    const remove = await homes.prepareRemoval('alpha');
    await rename(home, `${home}-saved`);
    await mkdir(home);
    await writeFile(join(home, 'user.txt'), 'Replaced');
    await expect(remove()).rejects.toMatchObject({ code: 'bot/invalid' });
    expect(await readFile(join(home, 'user.txt'), 'utf8')).toBe('Replaced');
  }));
});

describe('defaultCwd validation', () => {
  it('accepts existing absolute directories and rejects relative, missing, file and invalid paths', async () => facility(async (root) => {
    const file = join(root, 'file');
    await writeFile(file, 'Not a directory');
    await expect(validateDefaultCwd(root)).resolves.toBeUndefined();
    await expect(validateDefaultCwd(undefined)).resolves.toBeUndefined();
    for (const value of ['relative', '', '~/directory', join(root, 'missing'), file, `${root}\0bad`]) {
      await expect(validateDefaultCwd(value)).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    const selected = join(root, 'selected-link');
    await symlink(root, selected, 'dir');
    await expect(validateDefaultCwd(selected)).resolves.toBeUndefined();
  }));
});
