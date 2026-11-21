import { useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, StandardPropsOf } from '@deepseek-ai/dsh-client-ui-slots';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { sameBot, type BotKey } from '../shared/identity.js';
import type { FollowUpOrigin } from '../shared/proactive/follow-up.js';
import { activityPageSchema, type ActivityPage } from '../shared/proactive/protocol.js';
import type { BotCatalog, BotCatalogOptions, PollingCatalog } from './state.js';
import { createPollingCatalog } from './state.js';
import type { FollowUpSource } from './proactive/follow-up-state.js';

export interface PendingWorkRow {
  id: string; owner: BotKey; name: string; title: string; kind: 'input' | 'review' | 'unknown'; origin?: FollowUpOrigin;
}
interface NativeReference { id: string; owner: BotKey; name: string; origin?: FollowUpOrigin }
interface PendingWorkSnapshot {
  rows: PendingWorkRow[];
  native: NativeReference[];
  unavailable: { owner: BotKey; name: string }[];
}
export interface PendingWorkSource {
  catalog: PollingCatalog<PendingWorkSnapshot>;
  open(row: PendingWorkRow | NativeReference, native?: boolean): Promise<void>;
}
export type NativeStatusHook = StandardPropsOf<'main'>['useSessionStatus'];

/** Read-only projection of existing owner Remote pages. No pending row is an execution authorization. */
export function createPendingWorkSource(ctx: Context, bots: BotCatalog, followUp: FollowUpSource, io: {
  work(owner: BotKey, cursor?: string): Promise<ActivityPage>;
  openBot(owner: BotKey, ticketId?: string): void;
  openSession(id: string): Promise<void>;
}, options: BotCatalogOptions): PendingWorkSource {
  async function readBot(owner: BotKey, name: string, signal: AbortSignal) {
    const rows: PendingWorkRow[] = [], native: NativeReference[] = [];
    const subject = { kind: 'bot', bot: owner } as const;
    const state = await followUp.readSummary(subject);
    if (state.state === 'unavailable') throw new Error('Pending follow-up service unavailable');
    if (state.state !== 'ready') return { rows, native };
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await followUp.page({ subject, ...(cursor ? { cursor } : {}) });
      for (const card of page.rows) {
        const origin = card.when?.origin ?? card.origin;
        if (origin.kind === 'native-subagent') native.push({ id: origin.childSessionId, owner, name, origin });
        if (card.state !== 'open' || !['waiting-input', 'needs-review', 'failed', 'approval-pending'].includes(card.condition.kind)) continue;
        rows.push({ id: card.id, owner, name, title: card.title,
          kind: card.condition.kind === 'waiting-input' ? 'input' : 'review', origin });
      }
      cursor = page.next;
    } while (cursor);
    do {
      signal.throwIfAborted();
      const page = activityPageSchema.parse(await io.work(owner, cursor));
      if (page.collection !== 'work') throw new Error('Pending work collection mismatch');
      for (const work of page.rows) if (sameBot(work.target.bot, owner) && work.state === 'unknown') rows.push({
        id: work.assignmentId, owner, name, title: work.title, kind: 'unknown',
        origin: { kind: 'work', ticketId: work.ticketId, assignmentId: work.assignmentId },
      });
      cursor = page.next;
    } while (cursor);
    return { rows, native };
  }
  const catalog = createPollingCatalog<PendingWorkSnapshot>(ctx, { rows: [], native: [], unavailable: [] }, async signal => {
    const rows: PendingWorkRow[] = [], native: NativeReference[] = [], unavailable: PendingWorkSnapshot['unavailable'] = [];
    for (const { bot, status } of bots.getSnapshot().entries) {
      signal.throwIfAborted();
      const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
      if (status?.mainSessionId) native.push({ id: status.mainSessionId, owner, name: bot.name });
      try {
        const result = await readBot(owner, bot.name, signal);
        rows.push(...result.rows);
        native.push(...result.native);
      } catch {
        signal.throwIfAborted();
        unavailable.push({ owner, name: bot.name });
      }
    }
    return { rows, native: [...new Map(native.map(row => [row.id, row])).values()], unavailable };
  }, options);
  let subscribers = 0;
  ctx.effect(() => bots.watch?.(() => { if (subscribers) void catalog.refresh(); }) ?? (() => {}), 'dsh-bot: pending Bot identities');
  const subscribedCatalog = { ...catalog, subscribe(listener: () => void) {
    subscribers++;
    const off = catalog.subscribe(listener);
    let active = true;
    return () => { if (!active) return; active = false; off(); subscribers--; };
  } };
  return { catalog: subscribedCatalog, async open(row, native = false) {
    const current = bots.getSnapshot().entries.find(entry => sameBot({ botId: entry.bot.id, botCreatedAt: entry.bot.createdAt }, row.owner));
    if (!current)
      throw new Error('Pending Bot incarnation changed');
    if (native && (row.origin?.kind === 'native-subagent' ? row.origin.sessionId : row.id) !== current.status?.mainSessionId)
      throw new Error('Pending main conversation changed');
    if (native && row.origin) { followUp.openSession(row.origin, new AbortController().signal); return; }
    if (native) { await io.openSession(row.id); return; }
    if (row.origin?.kind === 'work') io.openBot(row.owner, row.origin.ticketId);
    else if (row.origin && row.origin.kind !== 'watch' && row.origin.kind !== 'group-turn')
      followUp.openSession(row.origin, new AbortController().signal, true);
    else io.openBot(row.owner);
  } };
}

export function PendingWork({ source, useSessionStatus, t }: PropsLocale<'dsh-bot'> & {
  source: PendingWorkSource; useSessionStatus?: NativeStatusHook;
}) {
  const snapshot = useSyncExternalStore(source.catalog.subscribe, source.catalog.getSnapshot, source.catalog.getSnapshot);
  const [failed, setFailed] = useState(false);
  return <>
    {(snapshot.rows.length > 0 || snapshot.unavailable.length > 0 || snapshot.error || failed) && <section data-pending-follow-up="" aria-label={t('pendingWork.title')}>
      <h2>{t('pendingWork.title')}</h2><p>{t('pendingWork.notice')}</p>
      {!snapshot.error && snapshot.rows.map(row => <p key={JSON.stringify([row.owner, row.id])} data-pending-kind={row.kind} data-pending-id={row.id} data-pending-bot={row.owner.botId}><Button variant="ghost"
        onClick={() => { void source.open(row).catch(() => setFailed(true)); }}>
        {row.name} · {t(`pendingWork.${row.kind}`)} · {row.title}
      </Button></p>)}
      {snapshot.unavailable.map(({ owner, name }) => <p role="status" key={JSON.stringify(owner)}>{t('pendingWork.botUnavailable', { name })}</p>)}
      {(failed || snapshot.error) && <p role="alert">{t('supergroup.unavailable')}</p>}
      {(failed || snapshot.error || snapshot.unavailable.length > 0) && <Button variant="ghost" onClick={() => {
        setFailed(false); void source.catalog.refresh();
      }}>{t('actions.retry')}</Button>}
    </section>}
    {useSessionStatus && <NativePending source={source} references={snapshot.native} useSessionStatus={useSessionStatus} t={t} />}
  </>;
}
function NativePending({ source, references, useSessionStatus, t }: PropsLocale<'dsh-bot'> & {
  source: PendingWorkSource; references: NativeReference[]; useSessionStatus: NativeStatusHook;
}) {
  const statuses = useSessionStatus(state => state), [failed, setFailed] = useState(false);
  const rows = references.filter(row => statuses.get(row.id as SessionId)?.pendingInteraction != null);
  if (!rows.length && !failed) return null;
  return <section data-pending-native-interaction="" aria-label={t('pendingWork.native')}>
    <h2>{t('pendingWork.native')}</h2><p>{t('pendingWork.nativeNotice')}</p>
    {rows.map(row => <p key={row.id} data-pending-kind="native" data-pending-id={row.id} data-pending-bot={row.owner.botId}><Button variant="ghost" onClick={() => { void source.open(row, true).catch(() => setFailed(true)); }}>
      {row.name} · {t('pendingWork.openNative')}
    </Button></p>)}
    {failed && <p role="alert">{t('supergroup.unavailable')}</p>}
  </section>;
}
