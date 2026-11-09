import type { DatabaseSync } from 'node:sqlite';
import { digest } from '../src/host/proactive/wire.js';
import { followUpCardSchema, subjectKey, type FollowUpPolicy, type Subject } from '../src/shared/proactive/follow-up.js';
import { followUpGroupPlanSchema, type FollowUpGroupAbandonInput, type FollowUpGroupInput, type FollowUpGroupPlanRequest } from '../src/shared/proactive/group-follow-up.js';
import { Rejection } from './rejection.js';

/** Durable authorization for one existing native group turn; no separate executor or Ticket. */
export function openGroupFollowUp(db: DatabaseSync, policy: (subject: Subject) => FollowUpPolicy) {
  db.exec(`CREATE TABLE IF NOT EXISTS pb_follow_up_group (
    operation TEXT PRIMARY KEY, subject TEXT NOT NULL, card_id TEXT NOT NULL, card_revision INTEGER NOT NULL,
    payload TEXT NOT NULL, UNIQUE(subject,card_id,card_revision))`);
  const head = db.prepare('SELECT card FROM pb_follow_up_head WHERE subject=? AND id=?');
  const get = db.prepare('SELECT payload FROM pb_follow_up_group WHERE operation=?');
  const lookup = db.prepare('SELECT payload FROM pb_follow_up_group WHERE subject=? AND card_id=? AND card_revision=?');
  const decode = (row: Record<string, unknown> | undefined) => row ? followUpGroupPlanSchema.parse(JSON.parse(String(row.payload))) : null;
  const revoked = (operation: string) => !!db.prepare("SELECT 1 FROM pb_governance_tombstone WHERE kind='follow-up-group' AND id=?").get(digest(operation));
  const epoch = () => {
    const row = db.prepare('SELECT epoch FROM pb_follow_up_recovery WHERE singleton=1').get();
    return typeof row?.epoch === 'string' ? row.epoch : null;
  };
  return {
    revoked,
    context(request: FollowUpGroupPlanRequest) {
      const key = subjectKey(request.subject);
      const row = head.get(key, request.cardId);
      return { plan: decode(lookup.get(key, request.cardId, request.expectedRevision)),
        card: row?.card ? followUpCardSchema.parse(JSON.parse(String(row.card))) : null, activationEpoch: epoch() };
    },
    accept(operation: string, input: FollowUpGroupInput) {
      if (revoked(operation)) throw new Rejection('forbidden');
      const previous = decode(get.get(operation));
      if (previous) { if (previous.inputDigest !== digest(input)) throw new Rejection('conflict'); return 0; }
      const key = subjectKey(input.subject);
      if (lookup.get(key, input.cardId, input.expectedRevision)) throw new Rejection('conflict');
      const currentPolicy = policy(input.subject);
      if (currentPolicy.revision !== input.expectedPolicyRevision) throw new Rejection('stale');
      if (!currentPolicy.localEnabled) throw new Rejection('forbidden');
      const stored = head.get(key, input.cardId);
      if (!stored?.card) throw new Rejection('stale');
      const card = followUpCardSchema.parse(JSON.parse(String(stored.card)));
      if (card.revision !== input.expectedRevision || card.state !== 'open' || card.condition.kind !== 'failed' ||
          card.origin.kind !== 'group-turn' || card.origin.turnId !== input.choice.predecessorTurnId)
        throw new Rejection('stale');
      const plan = followUpGroupPlanSchema.parse({ commandId: operation, input, inputDigest: digest(input), activationEpoch: epoch() });
      db.prepare('INSERT INTO pb_follow_up_group VALUES (?,?,?,?,?)')
        .run(operation, key, input.cardId, input.expectedRevision, JSON.stringify(plan));
      return 1;
    },
    abandon(input: FollowUpGroupAbandonInput) {
      const key = subjectKey(input.subject);
      const plan = decode(get.get(input.operationId));
      if (!plan || plan.turnId || subjectKey(plan.input.subject) !== key || plan.input.cardId !== input.cardId ||
          plan.input.expectedRevision !== input.expectedRevision) throw new Rejection('stale');
      const stored = head.get(key, input.cardId);
      if (!stored?.card) throw new Rejection('stale');
      const card = followUpCardSchema.parse(JSON.parse(String(stored.card)));
      if (card.revision !== input.expectedRevision || card.state !== 'open' || card.condition.kind !== 'failed' ||
          card.origin.kind !== 'group-turn' || card.origin.turnId !== plan.input.choice.predecessorTurnId)
        throw new Rejection('stale');
      db.prepare(`INSERT INTO pb_governance_tombstone (kind,id,source,generation,digest,at,audit)
        VALUES ('follow-up-group',?,?,?,?,?,'{}')`)
        .run(digest(input.operationId), `local:${digest(key)}`, input.expectedRevision, plan.inputDigest, Date.now());
      db.prepare('DELETE FROM pb_follow_up_group WHERE operation=?').run(input.operationId);
      db.prepare('UPDATE pb_follow_up_head SET card=? WHERE subject=? AND id=?')
        .run(JSON.stringify({ ...card, revision: card.revision + 1 }), key, card.id);
      return 1;
    },
    started(operation: string, inputDigest: string, turnId: string) {
      const plan = decode(get.get(operation));
      if (!plan || plan.inputDigest !== inputDigest) throw new Rejection('stale');
      if (plan.turnId) { if (plan.turnId !== turnId) throw new Rejection('conflict'); return 0; }
      if (plan.activationEpoch !== epoch()) throw new Rejection('forbidden');
      plan.turnId = turnId;
      db.prepare('UPDATE pb_follow_up_group SET payload=? WHERE operation=?').run(JSON.stringify(plan), operation);
      // The old failure has an explicitly accepted native continuation. Its new
      // native turn owns progress/error facts; this is not business acceptance.
      const key = subjectKey(plan.input.subject);
      const stored = head.get(key, plan.input.cardId);
      if (stored?.card) {
        const card = followUpCardSchema.parse(JSON.parse(String(stored.card)));
        if (card.revision === plan.input.expectedRevision && card.state === 'open')
          db.prepare('UPDATE pb_follow_up_head SET card=? WHERE subject=? AND id=?').run(JSON.stringify({
            ...card, revision: card.revision + 1, state: 'closed', condition: { kind: 'closed', reason: 'resolved' },
          }), key, card.id);
      }
      return 1;
    },
  };
}
