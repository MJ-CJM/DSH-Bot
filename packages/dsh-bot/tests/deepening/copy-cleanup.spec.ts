import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { eraseManagedGraphs, managedGraphFiles } from '../../src/host/reference-memory/cleanup-files.js';
describe('I17 managed graph generations', () => {
  it('erases current/stage/previous/orphan generations and is idempotent', async () => {
    const base = resolve('../../.dsh-dev/deepening/b4'); await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'copies-'));
    try {
      await mkdir(join(root, 'bot'));
      for (const name of ['current', 'stage', 'previous', 'orphan'])
        await writeFile(join(root, 'bot', `${name}.jsonl`), 'SYNTHETIC_COPY_CANARY');
      expect(await managedGraphFiles(root)).toHaveLength(4);
      await eraseManagedGraphs(root); await eraseManagedGraphs(root);
      expect(await managedGraphFiles(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('refuses symlink escape and preserves the external synthetic file', async () => {
    const base = resolve('../../.dsh-dev/deepening/b4'); await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'copy-links-'));
    try {
      const graph = join(root, 'managed'); await mkdir(graph); await mkdir(join(graph, 'bot'));
      const outside = join(root, 'outside.jsonl'); await writeFile(outside, 'EXTERNAL_BACKUP');
      await symlink(outside, join(graph, 'bot', 'escape.jsonl'));
      await expect(eraseManagedGraphs(graph)).rejects.toThrow('Unverifiable');
      expect(await readFile(outside, 'utf8')).toBe('EXTERNAL_BACKUP');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
