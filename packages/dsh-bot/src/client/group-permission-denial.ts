import type { ChatNode, ChatSnapshot, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client';

/**
 * Native structured tool-error codes that mean the access mode, not the tool,
 * blocked the call: the DSH file sandbox and the experimental Auto reviewer.
 * Shell/process failures carry no structured code and are deliberately not
 * guessed from text.
 */
export const PERMISSION_DENIAL_CODES: ReadonlySet<string> = new Set(['FS_SANDBOX_DENIED', 'AUTO_REVIEW_DENIED']);

const denied = (block: ToolCallBlock): boolean =>
  ('kind' in block && block.kind === 'tool-result' && block.isError && PERMISSION_DENIAL_CODES.has(block.error?.code ?? ''))
  || block.subCalls.some(denied);

/**
 * Whether a member's native Chat projection holds a settled tool call (or PTC
 * subcall) rejected by the access mode.
 * @param snapshot - the child Session's native Chat projection.
 * @returns true when at least one such denial is loaded.
 */
export function hasPermissionDenial(snapshot: ChatSnapshot | undefined): boolean {
  return (snapshot?.nodes.values() ?? []).some(node =>
    node.kind === 'tool-call' && denied((node as ChatNode<'tool-call'>).data.root));
}
