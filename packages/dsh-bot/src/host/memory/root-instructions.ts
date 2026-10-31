import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RootInstructions } from '../../shared/memory-forget.js';

// Native defaults, including their local overlays. Never open or remove instruction files.
export const rootCandidates = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'] as const;
export const rootInstructionNotice = 'Bots root instructions are loaded by DSH natively. They are outside shared memory quotas, '
  + 'conflict resolution and forgetting rules. Affected forgetting stays blocked until the source is handled and verified.';
export async function detectRootInstructions(root: string): Promise<RootInstructions> {
  const files = await Promise.all(rootCandidates.map(async name => {
    const path = join(root, name);
    try {
      const info = await lstat(path);
      return { path, state: info.isFile() ? 'present' as const : 'unknown' as const };
    } catch (error) {
      return { path, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' as const : 'unknown' as const };
    }
  }));
  return { root, files };
}
