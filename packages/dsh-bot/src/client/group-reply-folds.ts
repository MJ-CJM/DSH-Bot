import type { GroupKey, GroupTurn } from '../shared/groups.js';

/** Session-local presentation state. No message bodies or private drafts are retained. */
export class RoundReplyFolds {
  readonly replies = new Map<string, { seq: number; defaultOpen: boolean }>();
  private readonly choices = new Map<string, boolean>();
  private batch?: { open: boolean; through: number };
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getRevision = () => this.revision;

  observe(id: string, seq: number, defaultOpen: boolean) {
    const previous = this.replies.get(id);
    if (previous?.seq === seq && previous.defaultOpen === defaultOpen) return;
    this.replies.set(id, { seq, defaultOpen });
    this.changed();
  }
  expanded(id: string, seq: number, defaultOpen: boolean, reply: boolean) {
    const individual = this.choices.get(id);
    if (individual !== undefined) return individual;
    if (reply && this.batch && seq <= this.batch.through) return this.batch.open;
    return defaultOpen;
  }
  toggle(id: string, seq: number, defaultOpen: boolean, reply: boolean) {
    this.choices.set(id, !this.expanded(id, seq, defaultOpen, reply));
    this.changed();
  }
  setAll(open: boolean, through: number) {
    for (const [id, reply] of this.replies) {
      if (reply.seq <= through) this.choices.delete(id);
    }
    this.batch = { open, through };
    this.changed();
  }
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

export function autoFoldLongReplies(turn?: GroupTurn) {
  return Boolean(turn && !turn.guestQuestion && !turn.memoryStatusOnly && turn.orderedMemberIds.length > 1);
}

export class GroupReplyFolds {
  private readonly rounds = new Map<string, RoundReplyFolds>();
  forTurn(group: GroupKey, turn?: GroupTurn, turnId = turn?.id) {
    if (!turnId || (turn && (turn.id !== turnId || turn.group.groupId !== group.groupId ||
      turn.group.groupCreatedAt !== group.groupCreatedAt))) return;
    const key = JSON.stringify([group.groupId, group.groupCreatedAt, turnId]);
    let state = this.rounds.get(key);
    if (!state) { state = new RoundReplyFolds(); this.rounds.set(key, state); }
    return state;
  }
  clear() { this.rounds.clear(); }
}
