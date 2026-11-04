import { describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client';
import { hasPermissionDenial } from '../../src/client/group-permission-denial.js';

type Block = { kind?: 'tool-result'; phase?: 'start'; isError?: boolean; error?: { name: string; code: string }; subCalls: Block[] };
const result = (code?: string, subCalls: Block[] = []): Block => ({ kind: 'tool-result', isError: code !== undefined,
  ...(code ? { error: { name: 'FsError', code } } : {}), subCalls });
const running = (subCalls: Block[] = []): Block => ({ phase: 'start', subCalls });
const snapshot = (...roots: Block[]) => ({ nodes: { values: () => [
  { kind: 'assistant-step', data: { blocks: [] } },
  ...roots.map(root => ({ kind: 'tool-call', data: { root } })),
] } }) as unknown as ChatSnapshot;

describe('group permission denial', () => {
  it('detects native sandbox and Auto review denials, including PTC subcalls', () => {
    expect(hasPermissionDenial(snapshot(result('FS_SANDBOX_DENIED')))).toBe(true);
    expect(hasPermissionDenial(snapshot(result('AUTO_REVIEW_DENIED')))).toBe(true);
    expect(hasPermissionDenial(snapshot(result(undefined, [result(undefined), result('FS_SANDBOX_DENIED')])))).toBe(true);
    expect(hasPermissionDenial(snapshot(running([result('FS_SANDBOX_DENIED')])))).toBe(true);
  });
  it('ignores other failures, OS permission errors, running calls and missing projections', () => {
    expect(hasPermissionDenial(undefined)).toBe(false);
    expect(hasPermissionDenial(snapshot())).toBe(false);
    expect(hasPermissionDenial(snapshot(result(undefined), result('CODE_RUN_FAILED'), result('FS_PERMISSION_DENIED'), running()))).toBe(false);
  });
});
