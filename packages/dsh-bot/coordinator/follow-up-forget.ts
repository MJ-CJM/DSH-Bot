import type { Store } from './core.mjs';
import { Rejection } from './rejection.js';
import { digest } from '../src/host/proactive/wire.js';
import { followUpCardSchema, subjectKey, type FollowUpAction, type FollowUpPolicy } from '../src/shared/proactive/follow-up.js';

const redacted = '[redacted]';
const pageSize = 64;

interface StoredCopy {
  subject: string;
  id: string;
  source_generation: number;
  card: string;
  watch: string | null;
}

/** Call from the existing coordinator command transaction. The source's
 * original Work, native conversation, and unrelated local threads stay owned
 * by their existing retention mechanisms. */
export function openFollowUpForget(store: Store) {
  const db = store.db;
  const get = db.prepare('SELECT subject,id,source_generation,card,watch FROM pb_follow_up_head WHERE subject=? AND id=?');
  const copies = db.prepare(`SELECT subject,id,source_generation,card,watch FROM pb_follow_up_head
    WHERE json_extract(card,'$.origin.kind')='work'
    AND json_extract(card,'$.origin.ticketId') IN (SELECT value FROM json_each(?))`);
  const mark = db.prepare(`INSERT OR IGNORE INTO pb_governance_tombstone
    (kind,id,source,generation,digest,at,audit) VALUES (?,?,?,?,?,?,'{}')`);
  const plans = db.prepare('SELECT operation,card_revision,payload FROM pb_follow_up_group WHERE subject=? AND card_id=?');
  const removePlans = db.prepare('DELETE FROM pb_follow_up_group WHERE subject=? AND card_id=?');
  const remove = db.prepare('DELETE FROM pb_follow_up_head WHERE subject=? AND id=?');

  function erase(copy: StoredCopy) {
    const card = followUpCardSchema.parse(JSON.parse(copy.card));
    if (subjectKey(card.subject) !== copy.subject || card.id !== copy.id) throw new Rejection('conflict');
    const source = `local:${digest(copy.subject)}`;
    const threadKey = `${source}:${copy.id}`;
    const thread = store.threads.get(threadKey);
    if (thread && (thread.ref.source !== source || thread.ref.id !== copy.id ||
        thread.subscriptions.length || thread.correlated.length || thread.context?.length))
      throw new Rejection('conflict');
    let before: { at: string; id: string } | undefined;
    for (;;) {
      const triggers = store.read.threadTriggers(threadKey, pageSize, before);
      for (const trigger of triggers) {
        if (trigger.source !== source || trigger.threads.length !== 1 ||
            trigger.threads[0]?.source !== source || trigger.threads[0]?.id !== copy.id ||
            (trigger.meta.followUp !== true && trigger.meta.bodyRedacted !== true))
          throw new Rejection('conflict');
        const savedDigest = trigger.meta.bodyDigest;
        const bodyDigest = typeof savedDigest === 'string' && /^[a-f0-9]{64}$/.test(savedDigest) ? savedDigest : digest(trigger);
        store.triggers.save({
          ...trigger, text: redacted, channel: undefined, url: undefined,
          meta: { followUp: true, bodyRedacted: true, bodyDigest },
        });
        const disposition = store.triggers.disposition(trigger.id);
        if (disposition) store.triggers.saveDisposition(trigger.id, {
          ...disposition,
          filtered: disposition.filtered ? { code: 'redacted' } : undefined,
          handbacks: disposition.handbacks?.map(item => ({ ...item, reason: redacted })),
        });
      }
      const first = triggers[0];
      if (triggers.length < pageSize || !first) break;
      before = { at: first.at, id: first.id };
    }
    for (const decision of store.decisions.byThread(threadKey)) {
      if (decision.threadKey !== threadKey || decision.kind !== 'ignore' || decision.ticketId || decision.mandate)
        throw new Rejection('conflict');
      store.decisions.save({
        ...decision, audit: undefined,
        reason: decision.reason.map(reason => ({ code: 'redacted', triggerId: reason.triggerId })),
      });
    }
    if (thread) store.threads.save({ ...thread, meta: { bodyRedacted: true }, pending: [], evaluating: undefined });
    const now = Date.now();
    if (card.origin.kind === 'group-turn') {
      for (const plan of plans.all(copy.subject, copy.id))
        mark.run('follow-up-group', digest(plan.operation), source, Number(plan.card_revision), digest(plan.payload), now);
      removePlans.run(copy.subject, copy.id);
    }
    mark.run('follow-up', copy.id, source, copy.source_generation, digest([copy.card, copy.watch]), now);
    return Number(remove.run(copy.subject, copy.id).changes);
  }

  return {
    card(input: FollowUpAction, policy: FollowUpPolicy) {
      if (policy.revision !== input.expectedPolicyRevision) throw new Rejection('stale');
      const row = get.get(subjectKey(input.subject), input.cardId) as unknown as StoredCopy | undefined;
      if (!row?.card || followUpCardSchema.parse(JSON.parse(row.card)).revision !== input.expectedRevision)
        throw new Rejection('stale');
      return erase(row);
    },
    work(ticketIds: readonly string[]) {
      if (!ticketIds.length) return 0;
      const rows = copies.all(JSON.stringify(ticketIds)) as unknown as StoredCopy[];
      return rows.reduce((count, row) => count + erase(row), 0);
    },
  };
}
