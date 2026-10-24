import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { OperationError } from '../common/operations.js';

/** Managed files never follow existing symlinks, including ancestor directories. */
export async function safeDirectory(path: string, create = true): Promise<string> {
  const full = resolve(path);
  const parent = dirname(full);
  if (parent !== full) await safeDirectory(parent, create);
  try {
    const stat = await lstat(full);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(full)) !== full)
      throw new OperationError('invalid');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') || !create) throw error;
    await mkdir(full, { mode: 0o700 });
  }
  return full;
}
export function contained(root: string, child: string): string {
  const path = resolve(root, child),
    rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new OperationError('invalid');
  return path;
}
export async function checkedFile(path: string, maxBytes: number): Promise<string | undefined> {
  await safeDirectory(dirname(path));
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new OperationError('invalid');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
