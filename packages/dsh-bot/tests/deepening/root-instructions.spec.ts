import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { detectRootInstructions, rootInstructionNotice } from '../../src/host/memory/root-instructions.js';
describe('I20 root instruction metadata', () => {
  it('detects all native defaults, warns on symlinks, never returns contents or deletes files', async () => {
    const base = resolve('../../.dsh-dev/deepening/b4'); await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'roots-'));
    try {
      await writeFile(join(root, 'AGENTS.md'), 'ROOT_SYNTHETIC_SECRET');
      await writeFile(join(root, 'CLAUDE.local.md'), 'LOCAL_SYNTHETIC_SECRET');
      await symlink(join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'));
      const result = await detectRootInstructions(root);
      expect(result.files.map(f => f.state)).toEqual(['present', 'unknown', 'absent', 'present']);
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('ROOT_SYNTHETIC_SECRET');
      expect(rootInstructionNotice).toContain('outside shared memory');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
