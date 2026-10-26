// Distinct exercised mechanisms. Strong completion is independently judged, never inferred from a blocked request.
export const forgetCases = [
  'hot-version', 'related-duplicate', 'derived-lineage', 'earlier-revision', 'system-head',
  'runtime-context', 'user-history', 'tool-pair', 'assistant-replay', 'summary',
  'nonmonotonic', 'repeat-cleanup', 'stop-only', 'preview-log-cas', 'preview-inbox-cas',
  'preview-copy-cas', 'human-inbox', 'derived-inbox', 'prepared-lazy', 'unknown-summary',
  'retry-boundary', 'active-lease', 'copy-current', 'copy-stage', 'copy-previous',
  'copy-orphan', 'copy-unavailable', 'flush-failure', 'root-instructions', 'unload-guard',
  'approval-wait',
];
