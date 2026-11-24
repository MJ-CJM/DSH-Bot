import type { GroupView } from './groups.js';

// Only an explicit, standalone instruction selects status-only recording.
// A discussion about memory or a sentence quoting the instruction stays a normal turn.
export function memoryOnlyIntent(text: string): 'reference' | 'content' | undefined {
  const match = /^(?:请\s*)?(?:只(?:记下来|记录下来|记录记忆|保存到记忆)|just (?:note (?:this|it) down|save (?:this|it) to memory))(?:\s*[:：]\s*([\s\S]*)|[。.!！]?)$/iu.exec(text.trim());
  if (match) return match[1]?.trim() ? 'content' : 'reference';
}

/** A bare instruction can refer to one already published answer in the last completed round. */
export function singleMemoryReference(view: GroupView) {
  const last = view.turns.at(-1);
  if (!last || last.state !== 'completed' || last.memoryStatusOnly || last.proactive ||
      last.membershipRevision !== view.group.membershipRevision) return;
  const outputs = view.deliveries.filter(row => row.turnId === last.id && row.outputMessageId);
  if (outputs.length !== 1) return;
  return view.messages.find(row => row.id === outputs[0]?.outputMessageId && row.speaker && row.text.trim());
}
