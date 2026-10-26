import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { safeDirectory } from './files.js';

/** Enumerate every managed generation, including unreferenced interrupted stages. No external backup discovery. */
export async function managedGraphFiles(root: string): Promise<Array<{ path: string; size: number; mtime: number }>> {
  try { await safeDirectory(root, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const files: Array<{ path: string; size: number; mtime: number }> = [];
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unverifiable graph directory');
    const parent = join(root, directory.name);
    await safeDirectory(parent, false);
    for (const name of await readdir(parent)) {
      const path = join(parent, name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || !name.endsWith('.jsonl')) throw new Error('Unverifiable graph file');
      files.push({ path, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function eraseManagedGraphs(root: string): Promise<void> {
  for (const file of await managedGraphFiles(root)) await unlink(file.path);
  if ((await managedGraphFiles(root)).length) throw new Error('Managed graph cleanup incomplete');
}
