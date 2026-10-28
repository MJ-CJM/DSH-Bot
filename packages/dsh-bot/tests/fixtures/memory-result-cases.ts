import type { MemoryRecord } from '../../src/shared/schema.js';
export function memoryResultCases(memory: MemoryRecord): Record<string, [unknown, unknown]> {
  const uuid = '00000000-0000-4000-8000-000000000001';
  const preview = { previewRevision: uuid, memoryId: '00000000-0000-4000-8000-000000000002',
    mode: 'version', revision: 1, targets: [], sessionIds: [], versions: 1, historyNodes: 0, summaries: 0,
    copies: 0, pendingMessages: 0, conservative: true, rootInstructions: false };
  const status = { configured: true, effectiveAutoShare: false, reason: 'unverifiable-user-input',
    botDaily: 5, domainDaily: 20, timeZone: 'Asia/Shanghai', revision: 2 };
  return {
    autoShareStatus: [status, { ...status, effectiveAutoShare: true }],
    setAutoShare: [status, { ...status, reason: 'verified' }],
    list: [[memory], [{ ...memory, unknown: true }]], search: [[memory], [{ id: 'bad' }]],
    save: [{ id: 'memory-1', deduplicated: false }, { id: 'memory-1', deduplicated: 'false' }],
    update: [memory, { ...memory, source: { by: 'untrusted', at: 1 } }],
    delete: [undefined, { removed: true }], count: [201, -1], quarantineCount: [3, -1],
    rootInstructions: [{ root: '/synthetic', files: [] }, { root: '/synthetic', files: [], content: 'forbidden' }],
    cleanupStatuses: [[], [{ id: 'bad', strong: true }]],
    chooseForget: [{ id: uuid, stopped: true, strong: false, phase: 'blocked', reasons: ['history'], sessions: 3 }, { strong: true }],
    retryCleanup: [{ id: uuid, stopped: true, strong: false, phase: 'blocked', reasons: ['copies'], sessions: 3 }, { strong: true }],
    previewForget: [preview, { previewRevision: 'bad' }], previewShared: [preview, { previewRevision: 'bad' }],
    previewContribution: [preview, { previewRevision: 'bad' }],
    query: [{ revision: 1, rows: [], total: 0 }, { revision: -1, rows: [], total: 0 }],
    createManaged: [uuid, 'bad'], confirm: [uuid, 'bad'], revise: [undefined, {}], resolve: [undefined, {}],
  };
}
