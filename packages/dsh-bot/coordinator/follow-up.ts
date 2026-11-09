import type { DatabaseSync } from 'node:sqlite';
import type { Engine } from './core.mjs';
import { Rejection } from './rejection.js';
import { ActivityCursor } from './query-pages.js';
import { digest } from '../src/host/proactive/wire.js';
import { workSchema, type ProactiveWork } from '../src/shared/proactive/work.js';
import {
  followUpCardSchema, followUpPolicySchema, followUpWatchSchema, subjectKey,
  type FollowUpAction, type FollowUpBootstrap, type FollowUpCard, type FollowUpFact, type FollowUpGroupWatchProposal, type FollowUpIngest,
  type FollowUpOrigin, type FollowUpPageRequest, type FollowUpPolicy,
  type FollowUpPolicyChange, type FollowUpSourceRequest, type FollowUpWatchCreate, type FollowUpWatchUpdate, type Subject,
} from '../src/shared/proactive/follow-up.js';

function originKey(origin: FollowUpOrigin) {
  switch (origin.kind) {
    case 'work': return [origin.kind, origin.ticketId];
    case 'delegate': return [origin.kind, origin.runId];
    case 'native-subagent': return [origin.kind, origin.sessionId, origin.childSessionId];
    case 'team-task': return [origin.kind, origin.teamId, origin.taskId];
    case 'group-turn': return [origin.kind, origin.turnId];
    case 'watch': return [origin.kind, origin.watchId];
  }
}

function validateFact(subject: Subject, fact: FollowUpFact) {
  if ((fact.origin.kind === 'group-turn' && subject.kind !== 'group') ||
      (['delegate', 'team-task', 'native-subagent'].includes(fact.origin.kind) && subject.kind !== 'bot') ||
      (fact.condition.kind === 'needs-review' && fact.origin.kind !== 'work') ||
      (fact.condition.kind === 'tracking' && fact.condition.completion !== undefined) ||
      (fact.condition.kind === 'failed' && fact.condition.members !== undefined &&
        (fact.origin.kind !== 'group-turn' || new Set(fact.condition.members.map(row => row.deliveryId)).size !== fact.condition.members.length)))
    throw new Rejection('invalid');
}

export function openFollowUp(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS pb_follow_up_policy (subject TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS pb_follow_up_enabled ON pb_follow_up_policy(json_extract(payload,'$.localEnabled'),subject);
    CREATE TABLE IF NOT EXISTS pb_follow_up_recovery (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pb_follow_up_head (
      subject TEXT NOT NULL, id TEXT NOT NULL, source_generation INTEGER NOT NULL,
      native_revision INTEGER NOT NULL, payload_digest TEXT NOT NULL, observed_at TEXT NOT NULL,
      card TEXT, watch TEXT, PRIMARY KEY(subject,id)
    );
    CREATE INDEX IF NOT EXISTS pb_follow_up_subject_recent ON pb_follow_up_head(subject, observed_at DESC, id);
    CREATE INDEX IF NOT EXISTS pb_follow_up_work_copy ON pb_follow_up_head(json_extract(card,'$.origin.ticketId'))
      WHERE json_extract(card,'$.origin.kind')='work';`);

  const cursors = new ActivityCursor();
  const policySource = '@follow-up-policy';
  const readPolicy = db.prepare('SELECT payload FROM pb_follow_up_policy WHERE subject=?');
  const readHead = db.prepare('SELECT * FROM pb_follow_up_head WHERE subject=? AND id=?');
  const forgotten = db.prepare('SELECT 1 FROM pb_governance_tombstone WHERE kind=? AND id=?');
  const decodeCard = (row: { card: unknown }) => followUpCardSchema.parse(JSON.parse(String(row.card)));
  const scopedRecovery = () => Boolean(db.prepare('SELECT 1 FROM pb_follow_up_recovery WHERE singleton=1').get());

  function sourceCheckpoint(input: FollowUpSourceRequest) {
    const id = `local:${digest([subjectKey(input.subject), input.sourceId])}`;
    const row = db.prepare('SELECT generation,checkpoint FROM pb_source WHERE id=?').get(id);
    if (row && Number(row.generation) > input.sourceGeneration) throw new Rejection('stale');
    return { id, cursor: row?.generation === input.sourceGeneration && typeof row.checkpoint === 'string' ? row.checkpoint : null };
  }

  function policy(subject: Subject): FollowUpPolicy {
    const row = readPolicy.get(subjectKey(subject));
    return row ? followUpPolicySchema.parse(JSON.parse(String(row.payload))) : {
      subject, revision: 0, pauseEpoch: 0, localEnabled: false, legacyCi: 'inherit', observationStart: null,
    };
  }

  function changePolicy(input: FollowUpPolicyChange) {
    const current = policy(input.subject);
    if (current.revision !== input.expectedRevision) throw new Rejection('stale');
    const pause = input.action === 'pause';
    if (pause ? !current.localEnabled && current.legacyCi === 'denied' : current.localEnabled) return 0;
    const next: FollowUpPolicy = {
      ...current,
      revision: current.revision + 1,
      pauseEpoch: current.pauseEpoch + Number(pause),
      localEnabled: !pause,
      legacyCi: pause ? 'denied' : current.legacyCi,
      observationStart: pause ? current.observationStart : current.observationStart ?? Date.now(),
    };
    db.prepare(`INSERT INTO pb_follow_up_policy VALUES (?,?) ON CONFLICT(subject)
      DO UPDATE SET payload=excluded.payload`).run(subjectKey(input.subject), JSON.stringify(next));
    db.prepare(`INSERT INTO pb_source VALUES (?,1,NULL) ON CONFLICT(id)
      DO UPDATE SET generation=pb_source.generation+1`).run(policySource);
    return 1;
  }

  function bootstrap(input: FollowUpBootstrap) {
    const existing = db.prepare('SELECT epoch FROM pb_follow_up_recovery WHERE singleton=1').get();
    if (existing?.epoch === input.configEpoch) throw new Rejection('conflict');
    if (input.expectedRevision !== null && input.expectedRevision !== policy(input.subject).revision) throw new Rejection('stale');
    db.exec(`UPDATE pb_follow_up_policy SET payload=json_set(payload,
      '$.localEnabled',json('false'), '$.legacyCi','denied', '$.observationStart',NULL,
      '$.revision',json_extract(payload,'$.revision')+1, '$.pauseEpoch',json_extract(payload,'$.pauseEpoch')+1)
      WHERE json_extract(payload,'$.localEnabled')=1`);
    db.prepare(`INSERT INTO pb_follow_up_recovery VALUES(1,?) ON CONFLICT(singleton)
      DO UPDATE SET epoch=excluded.epoch`).run(input.configEpoch);
    return changePolicy({ action: 'enable-local', subject: input.subject, expectedRevision: policy(input.subject).revision });
  }

  type Projection = Omit<FollowUpFact, 'condition'> & { condition: FollowUpCard['condition'] };
  function project(engine: Engine, subject: Subject, fact: Projection, generation: number, previous?: FollowUpCard) {
    const key = subjectKey(subject);
    const id = digest([key, originKey(fact.origin)]);
    const triggerId = digest([id, generation, fact.nativeId, fact.nativeRevision, fact.payloadDigest]);
    const source = `local:${digest(key)}`;
    const outcome = engine.receive({
      id: triggerId, source, human: false, actor: { source, id: 'local-host' },
      threads: [{ source, id }], text: 'Local follow-up fact', at: fact.occurredAt, meta: { followUp: true },
    });
    if (outcome !== 'stored') throw new Rejection('conflict');
    const decision = engine.decide(triggerId, {
      kind: 'ignore', reason: { code: 'localFollowUpObserved' },
    });
    const ignored = previous?.state === 'ignored' && previous.condition.kind === fact.condition.kind &&
      (fact.origin.kind !== 'work' || (previous.origin.kind === 'work' && previous.origin.assignmentId === fact.origin.assignmentId));
    return followUpCardSchema.parse({
      id, decisionId: decision.id, subject, origin: fact.origin, title: fact.title,
      revision: previous ? previous.revision + 1 : 0, observedAt: fact.occurredAt,
      condition: fact.condition, state: fact.condition.kind === 'closed' ? 'closed' : ignored ? 'ignored' : 'open',
    });
  }

  function saveHead(key: string, id: string, generation: number, fact: FollowUpFact, eventDigest: string, card: FollowUpCard | null) {
    db.prepare(`INSERT INTO pb_follow_up_head VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(subject,id)
      DO UPDATE SET source_generation=excluded.source_generation,native_revision=excluded.native_revision,
      payload_digest=excluded.payload_digest,observed_at=excluded.observed_at,card=excluded.card`).run(
      key, id, generation, fact.nativeRevision, eventDigest, fact.occurredAt, card ? JSON.stringify(card) : null,
    );
  }

  function observeWork(engine: Engine, row: ProactiveWork) {
    if (row.methodTrial || row.state === 'superseded') return;
    const subject: Subject = row.groupRepair ? { kind: 'group', group: row.groupRepair.group } : { kind: 'bot', bot: row.target.bot };
    if (!policy(subject).localEnabled) return;
    const key = subjectKey(subject);
    const origin = { kind: 'work', ticketId: row.ticketId, assignmentId: row.assignmentId } as const;
    const id = digest([key, originKey(origin)]);
    if (forgotten.get('follow-up', id) || forgotten.get('work', row.assignmentId)) return;
    const current = readHead.get(key, id);
    if (current && Number(current.native_revision) >= row.revision) return;
    const previous = current?.card ? decodeCard({ card: current.card }) : undefined;
    if (previous?.state === 'stopped') return;
    let condition: FollowUpFact['condition'];
    switch (row.state) {
      case 'pending': case 'claimed': case 'sent': condition = { kind: 'tracking' }; break;
      case 'delivered': condition = row.wait ? { kind: 'waiting-input', wait: { reason: row.wait.reason, request: row.wait.request } } : { kind: 'needs-review' }; break;
      case 'failed': condition = { kind: 'failed' }; break;
      case 'accepted': condition = { kind: 'closed', reason: 'completed' }; break;
      case 'cancelled': condition = { kind: 'closed', reason: 'cancelled' }; break;
      case 'unknown': case 'denied': condition = { kind: 'closed', reason: 'resolved' }; break;
    }
    const fact: FollowUpFact = {
      origin, nativeId: row.assignmentId, nativeRevision: row.revision, occurredAt: new Date().toISOString(),
      payloadDigest: digest([origin, row.revision, row.state, row.evidenceDigest ?? null, row.wait ?? null]),
      title: row.title.slice(0, 500).trim() || row.ticketId, condition,
    };
    const card = !previous && condition.kind === 'closed' ? null : project(engine, subject, fact, 0, previous);
    saveHead(key, id, 0, fact, digest(fact), card);
  }

  function reconcileWork(engine: Engine, subject: Subject, expectedPolicyRevision: number) {
    const current = policy(subject);
    if (current.revision !== expectedPolicyRevision) throw new Rejection('stale');
    if (!current.localEnabled) throw new Rejection('forbidden');
    const key = subjectKey(subject);
    const source = `@work-reconcile:${digest(key)}`;
    const checkpoint = db.prepare('SELECT generation,checkpoint FROM pb_source WHERE id=?').get(source);
    if (checkpoint?.generation === current.revision && checkpoint.checkpoint === null) return 0;
    const filter = subject.kind === 'bot' ? `json_extract(w.payload,'$.groupRepair') IS NULL
      AND json_extract(w.payload,'$.target.bot.botId')=? AND json_extract(w.payload,'$.target.bot.botCreatedAt')=?` :
      `json_extract(w.payload,'$.groupRepair.group.groupId')=? AND json_extract(w.payload,'$.groupRepair.group.groupCreatedAt')=?`;
    const [id, createdAt] = subject.kind === 'bot' ? [subject.bot.botId, subject.bot.botCreatedAt] : [subject.group.groupId, subject.group.groupCreatedAt];
    const { after, through } = checkpoint?.generation === current.revision
      ? JSON.parse(String(checkpoint.checkpoint)) as { after: number; through: number }
      : { after: 0, through: Number(db.prepare(`SELECT max(w.rowid) AS last FROM pb_work w WHERE ${filter}`).get(id, createdAt)?.last ?? 0) };
    const rows = db.prepare(`SELECT w.rowid,w.payload,
      w.generation=(SELECT max(p.generation) FROM pb_work p WHERE p.ticket=w.ticket) AS current
      FROM pb_work w WHERE w.rowid>? AND w.rowid<=? AND ${filter}
      ORDER BY w.rowid LIMIT 101`).all(after, through, id, createdAt);
    const page = rows.slice(0, 100);
    const active = scopedRecovery() ? ['delivered'] : ['pending', 'claimed', 'sent', 'delivered'];
    for (const row of page) {
      if (!row.current) continue;
      const work = workSchema.parse(JSON.parse(String(row.payload)));
      if (active.includes(work.state) || readHead.get(key, digest([key, ['work', work.ticketId]]))?.card)
        observeWork(engine, work);
    }
    const next = rows.length > page.length ? JSON.stringify({ after: Number(page.at(-1)?.rowid), through }) : null;
    db.prepare(`INSERT INTO pb_source VALUES (?,?,?) ON CONFLICT(id)
      DO UPDATE SET generation=excluded.generation,checkpoint=excluded.checkpoint`).run(source, current.revision, next);
    return page.length;
  }

  function ingest(engine: Engine, input: FollowUpIngest) {
    const current = policy(input.subject);
    if (!current.localEnabled || current.pauseEpoch !== input.pauseEpoch || current.observationStart === null)
      throw new Rejection('forbidden');
    const key = subjectKey(input.subject);
    const source = sourceCheckpoint(input);
    if (source.cursor !== input.expectedCursor) throw new Rejection('stale');
    let stored = 0;
    for (const fact of input.facts) {
      if (fact.origin.kind === 'work') throw new Rejection('forbidden');
      validateFact(input.subject, fact);
      const id = digest([key, originKey(fact.origin)]);
      if (forgotten.get('follow-up', id)) continue;
      const eventId = digest(['local-follow-up', key, id, input.sourceGeneration, fact.nativeId, fact.nativeRevision]);
      const eventDigest = digest({ ...fact, current: undefined });
      const known = db.prepare('SELECT digest FROM pb_event WHERE id=?').get(eventId);
      if (known && known.digest !== eventDigest) throw new Rejection('conflict');
      if (!known) db.prepare('INSERT INTO pb_event VALUES (?,?)').run(eventId, eventDigest);
      const row = readHead.get(key, id);
      if (row && (Number(row.source_generation) > input.sourceGeneration ||
          (row.source_generation === input.sourceGeneration && Number(row.native_revision) > fact.nativeRevision))) continue;
      if (row && row.source_generation === input.sourceGeneration && row.native_revision === fact.nativeRevision) {
        if (row.payload_digest !== eventDigest) throw new Rejection('conflict');
        continue;
      }
      if (Date.parse(fact.occurredAt) < current.observationStart &&
          (!fact.current || fact.condition.kind === 'failed')) continue;
      const previous = row?.card && decodeCard({ card: row.card });
      if (previous && previous.state === 'stopped') continue;
      const card = !previous && fact.condition.kind === 'closed' ? null :
        project(engine, input.subject, fact, input.sourceGeneration, previous || undefined);
      saveHead(key, id, input.sourceGeneration, fact, eventDigest, card);
      stored++;
    }
    db.prepare(`INSERT INTO pb_source VALUES (?,?,?) ON CONFLICT(id)
      DO UPDATE SET generation=excluded.generation,checkpoint=excluded.checkpoint`).run(source.id, input.sourceGeneration, input.nextCursor);
    return stored;
  }

  function createWatch(engine: Engine, input: FollowUpWatchCreate | FollowUpGroupWatchProposal) {
    const current = policy(input.subject);
    if (current.revision !== input.expectedRevision) throw new Rejection('stale');
    if (!current.localEnabled) throw new Rejection('forbidden');
    const key = subjectKey(input.subject);
    const proposed = input.watch.source.kind === 'group-proposal';
    if (proposed && db.prepare(`SELECT 1 FROM pb_follow_up_head WHERE subject=?
        AND json_extract(watch,'$.state')='pending' LIMIT 1 OFFSET 999`).get(key)) throw new Rejection('forbidden');
    const watch = followUpWatchSchema.parse({
      ...input.watch, kind: 'explicit-watch/v1', id: input.id, subject: input.subject, revision: 0,
      state: proposed ? 'pending' : 'active',
    });
    const origin = { kind: 'watch', watchId: watch.id } as const;
    const id = digest([key, originKey(origin)]);
    if (readHead.get(key, id) || forgotten.get('follow-up', id)) throw new Rejection('conflict');
    const fact: Projection = {
      origin, nativeId: watch.id, nativeRevision: 0, occurredAt: new Date().toISOString(),
      payloadDigest: digest(watch), title: watch.title,
      condition: proposed ? { kind: 'approval-pending', completion: watch.completion, ...(watch.wait ? { wait: watch.wait } : {}) }
        : watch.wait ? { kind: 'waiting-input', wait: watch.wait } : { kind: 'tracking', completion: watch.completion },
    };
    const card = project(engine, input.subject, fact, 0);
    db.prepare('INSERT INTO pb_follow_up_head VALUES (?,?,?,?,?,?,?,?)').run(
      key, id, 0, 0, fact.payloadDigest, card.observedAt, JSON.stringify(card), JSON.stringify(watch),
    );
    return 1;
  }

  function updateWatch(engine: Engine, input: FollowUpWatchUpdate) {
    const current = policy(input.subject);
    if (current.revision !== input.expectedPolicyRevision) throw new Rejection('stale');
    if (!current.localEnabled) throw new Rejection('forbidden');
    const key = subjectKey(input.subject);
    const row = readHead.get(key, input.cardId);
    if (!row?.card || !row.watch) throw new Rejection('stale');
    const card = decodeCard({ card: row.card });
    const previous = followUpWatchSchema.parse(JSON.parse(String(row.watch)));
    if (card.revision !== input.expectedRevision || previous.state !== 'active' ||
        card.state === 'stopped' || card.state === 'closed') throw new Rejection('stale');
    const watch = followUpWatchSchema.parse({
      ...previous, ...input.watch, wait: input.watch.wait, revision: previous.revision + 1,
    });
    const fact: FollowUpFact = {
      origin: card.origin, nativeId: watch.id, nativeRevision: watch.revision,
      occurredAt: new Date().toISOString(), payloadDigest: digest(watch), title: watch.title,
      condition: watch.wait ? { kind: 'waiting-input', wait: watch.wait } : { kind: 'tracking', completion: watch.completion },
    };
    const next = project(engine, input.subject, fact, 0, card);
    db.prepare('UPDATE pb_follow_up_head SET native_revision=?,payload_digest=?,observed_at=?,card=?,watch=? WHERE subject=? AND id=?')
      .run(watch.revision, fact.payloadDigest, next.observedAt, JSON.stringify(next), JSON.stringify(watch), key, card.id);
    return 1;
  }

  function act(input: FollowUpAction, commandId: string) {
    const current = policy(input.subject);
    if (current.revision !== input.expectedPolicyRevision) throw new Rejection('stale');
    if (!current.localEnabled) throw new Rejection('forbidden');
    const key = subjectKey(input.subject);
    const row = readHead.get(key, input.cardId);
    if (!row?.card) throw new Rejection('stale');
    const card = decodeCard({ card: row.card });
    if (card.revision !== input.expectedRevision || card.state === 'stopped' || card.state === 'closed') throw new Rejection('stale');
    const watch = row.watch ? followUpWatchSchema.parse(JSON.parse(String(row.watch))) : null;
    if (input.action === 'confirm-watch') {
      if (input.subject.kind !== 'group' || card.state !== 'open' || card.condition.kind !== 'approval-pending' ||
          watch?.state !== 'pending' || watch.source.kind !== 'group-proposal') throw new Rejection('forbidden');
      const confirmed = { ...watch, state: 'active', revision: watch.revision + 1,
        source: { ...watch.source, confirmationId: commandId } };
      const next: FollowUpCard = { ...card, revision: card.revision + 1,
        condition: watch.wait ? { kind: 'waiting-input', wait: watch.wait } : { kind: 'tracking', completion: watch.completion } };
      db.prepare('UPDATE pb_follow_up_head SET card=?,watch=? WHERE subject=? AND id=?').run(
        JSON.stringify(next), JSON.stringify(confirmed), key, card.id);
      return 1;
    }
    if (input.action === 'complete' && watch?.state !== 'active') throw new Rejection('forbidden');
    if (input.action === 'ignore' && card.state === 'ignored') return 0;
    const next: FollowUpCard = {
      ...card, revision: card.revision + 1,
      state: input.action === 'ignore' ? 'ignored' : input.action === 'stop' ? 'stopped' : 'closed',
      ...(input.action === 'complete' ? { condition: { kind: 'closed', reason: 'completed' } } : {}),
    };
    if (watch && input.action !== 'ignore') {
      watch.state = input.action === 'complete' ? 'completed' : 'stopped';
      watch.revision++;
    }
    db.prepare('UPDATE pb_follow_up_head SET card=?,watch=? WHERE subject=? AND id=?').run(
      JSON.stringify(next), watch ? JSON.stringify(watch) : null, key, card.id,
    );
    return 1;
  }

  return {
    policy, changePolicy, ingest, createWatch, updateWatch, act, scopedRecovery, bootstrap, observeWork, reconcileWork,
    allowsLegacy(subject?: Subject) {
      return !scopedRecovery() && (!subject || policy(subject).legacyCi !== 'denied');
    },
    summary(subject: Subject, legacyCiActive: boolean) {
      const current = policy(subject);
      const rows = current.localEnabled ? db.prepare(`SELECT card FROM pb_follow_up_head WHERE subject=?
        AND json_extract(card,'$.state') IN ('open','closed') ORDER BY observed_at DESC,id LIMIT 3`)
        .all(subjectKey(subject)).map(row => decodeCard(row as { card: unknown })) : [];
      return { policy: current, legacyCiActive, rows };
    },
    page(input: FollowUpPageRequest, storeId: string, sequence: number) {
      const key = subjectKey(input.subject);
      const binding = JSON.stringify([storeId, sequence, key]);
      const offset = cursors.decode(input.cursor, binding);
      const rows = db.prepare(`SELECT card FROM pb_follow_up_head WHERE subject=? AND card IS NOT NULL ORDER BY observed_at DESC,id LIMIT 21 OFFSET ?`)
        .all(key, offset).map(row => decodeCard(row as { card: unknown }));
      return { rows: rows.slice(0, 20), ...(rows.length > 20 ? { next: cursors.encode(binding, offset + 20) } : {}) };
    },
    subjects(cursor: string | undefined, storeId: string) {
      const sequence = db.prepare('SELECT generation FROM pb_source WHERE id=?').get(policySource)?.generation ?? 0;
      const binding = JSON.stringify([storeId, sequence, 'enabled-follow-up-subjects']);
      const offset = cursors.decode(cursor, binding);
      const rows = db.prepare(`SELECT payload FROM pb_follow_up_policy WHERE json_extract(payload,'$.localEnabled')=1
        ORDER BY subject LIMIT 21 OFFSET ?`).all(offset).map(row => followUpPolicySchema.parse(JSON.parse(String(row.payload))));
      return { rows: rows.slice(0, 20), ...(rows.length > 20 ? { next: cursors.encode(binding, offset + 20) } : {}) };
    },
    sourceCursor(input: FollowUpSourceRequest) { return sourceCheckpoint(input).cursor; },
  };
}
