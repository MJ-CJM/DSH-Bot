import { useEffect, useId, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupDelivery, GroupView } from '../../shared/groups.js';
import { groupKey } from '../../shared/groups.js';
import { groupExportReviewStatus } from '../../shared/group-export-review.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import type { GroupMethods } from '../../shared/groups-contract.js';
import type { BotRecord } from '../../shared/schema.js';
import { type GroupActions, unwrapGroup } from '../groups-state.js';
import styles from '../styles/groups.module.css';

type Preview = Extract<Awaited<ReturnType<GroupMethods['reviewExport']>>, { ok: true }>['value'];
type Receipt = 'sent' | 'rejected' | 'changed' | 'unavailable' | 'previewFailed' | 'uncertain' | 'preferenceFailed' | 'sentReceiptFailed';
type Item = { identity: string; delivery: GroupDelivery; preview?: Preview; selected?: boolean; later?: boolean; receipt?: Receipt; processing?: 'preview' | 'decision' };
type StaleResult = { closed: number } | 'conflict' | 'failed';
const identity = (delivery: GroupDelivery, membershipRevision: number) => JSON.stringify([delivery.id, delivery.revision, delivery.exportFlowId, membershipRevision]);
const failure = (error: unknown): Receipt => hasOperationCode(error, 'group-export-preference-failed') ? 'preferenceFailed'
  : hasOperationCode(error, 'group-export-sent-receipt-failed') ? 'sentReceiptFailed'
  : hasOperationCode(error, 'conflict') ? 'changed' : hasOperationCode(error, 'group-data-blocked') ? 'unavailable' : 'uncertain';
const finished = (receipt?: Receipt) => receipt === 'sent' || receipt === 'rejected' || receipt === 'preferenceFailed' || receipt === 'sentReceiptFailed';

/** History carries a locator, while the only decision controls live by input. */
export function GroupExportQueueLink({ view, actions, stale, t }: { view: GroupView; actions: GroupActions; stale?: boolean } & PropsLocale<'dsh-bot'>) {
  const [failed, setFailed] = useState(false);
  const focus = () => {
    const target = [...document.querySelectorAll<HTMLElement>('[data-group-export-queue]')].find(node => node.dataset.groupExportQueue === view.group.id);
    if (!target) return false;
    if (!stale) target.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
    target.scrollIntoView?.({ block: 'nearest' }); target.focus({ preventScroll: true });
    return true;
  };
  return <><button type="button" onClick={() => {
    if (focus()) return;
    setFailed(false);
    void actions.open(groupKey(view.group)).then(() => requestAnimationFrame(focus)).catch(() => setFailed(true));
  }}>{t(stale ? 'groups.export.openExpired' : 'groups.export.openQueue')}</button>{failed && <p role="alert">{t('groups.disconnected')}</p>}</>;
}

/** One owner-only queue in the composer seat. Selection never grants authority;
 * every dispatch still carries its own exact Host-issued preview token. */
export function GroupExportQueue({ view, bots, actions, t }: {
  view: GroupView; bots: readonly BotRecord[]; actions: GroupActions;
} & PropsLocale<'dsh-bot'>) {
  const [items, setItems] = useState<Record<string, Item>>({});
  const [expanded, setExpanded] = useState(false), [showLater, setShowLater] = useState(false), [busy, setBusy] = useState(false);
  const [batchSending, setBatchSending] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [staleResult, setStaleResult] = useState<StaleResult>();
  const lock = useRef(false), alive = useRef(true), region = useRef<HTMLElement>(null), listId = useId();
  const currentView = useRef(view); currentView.current = view;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setItems(previous => {
      let changed = false;
      const next = Object.fromEntries(Object.entries(previous).map(([id, item]) => {
        const delivery = view.deliveries.find(row => row.id === id);
        if (!item.preview || delivery && item.identity === identity(delivery, view.group.membershipRevision)) return [id, item];
        changed = true;
        return [id, { ...item, preview: undefined, selected: false }];
      }));
      return changed ? next : previous;
    });
  }, [view.deliveries, view.group.membershipRevision]);
  const key = groupKey(view.group);
  const turnsById = new Map(view.turns.map(turn => [turn.id, turn]));
  const statuses = new Map(view.deliveries.map(delivery => [delivery.id, groupExportReviewStatus(view.group, turnsById.get(delivery.turnId), delivery)]));
  const pendingRows = view.deliveries.filter(delivery => statuses.get(delivery.id) === 'pending');
  const currentDeliveries = new Map(view.deliveries.map(delivery => [delivery.id, delivery]));
  const reconciled = (item: Item) => {
    if (item.receipt !== 'uncertain') return item;
    const before = item.delivery, row = currentDeliveries.get(before.id);
    if (!row || row.turnId !== before.turnId || row.memberId !== before.memberId ||
        row.bot.botId !== before.bot.botId || row.bot.botCreatedAt !== before.bot.botCreatedAt ||
        (row.revision ?? 0) <= (before.revision ?? 0)) return item;
    if (row.outputMessageId && row.outputSeq !== undefined)
      return { ...item, delivery: row, receipt: 'sent' as const };
    if (!row.exportFlowId && row.reasonCode === 'export-rejected')
      return { ...item, delivery: row, receipt: 'rejected' as const };
    return item;
  };
  const receiptRows = Object.values(items).map(reconciled).filter(item => statuses.get(item.delivery.id) !== 'pending'
    && (finished(item.receipt) || item.receipt === 'uncertain'));
  const clearableReceipts = receiptRows.filter(item => finished(item.receipt));
  const rows = [...pendingRows, ...receiptRows.map(item => item.delivery)];
  const staleCount = view.deliveries.filter(delivery => statuses.get(delivery.id) === 'stale').length;
  const current = (delivery: GroupDelivery) => {
    const item = items[delivery.id];
    // Confirmed and uncertain decisions are receipts, not reusable authority.
    // A later membership update must never turn them back into a send control.
    if (item && (finished(item.receipt) || item.receipt === 'uncertain')) return reconciled(item);
    return item?.identity === identity(delivery, view.group.membershipRevision) ? item : { identity: identity(delivery, view.group.membershipRevision), delivery };
  };
  const patch = (delivery: GroupDelivery, value: Partial<Item>) => setItems(previous => {
    const expected = identity(delivery, view.group.membershipRevision), before = previous[delivery.id];
    return { ...previous, [delivery.id]: { ...(before?.identity === expected ? before : {}), identity: expected, delivery, ...value } };
  });
  const nameOf = (delivery: GroupDelivery) => bots.find(bot => bot.id === delivery.bot.botId && bot.createdAt === delivery.bot.botCreatedAt)?.name ?? delivery.bot.botId;
  const select = (delivery: GroupDelivery, checked: boolean) => setItems(previous => {
    const scoped = checked ? Object.fromEntries(Object.entries(previous).map(([id, item]) => [id,
      item.delivery.turnId === delivery.turnId ? item : { ...item, selected: false }])) : previous;
    const expected = identity(delivery, view.group.membershipRevision), before = scoped[delivery.id];
    return { ...scoped, [delivery.id]: { ...(before?.identity === expected ? before : {}), identity: expected, delivery, selected: checked } };
  });
  const selected = pendingRows.filter(delivery => { const item = current(delivery); return item.preview && item.selected && !item.receipt; });
  const pendingCount = pendingRows.filter(delivery => !finished(current(delivery).receipt)).length;
  const laterCount = pendingRows.filter(delivery => current(delivery).later && !current(delivery).receipt).length;
  const focusReceipt = (deliveryId: string) => {
    const node = [...(region.current?.querySelectorAll<HTMLElement>('[data-export-receipt]') ?? [])].find(element => element.dataset.exportReceipt === deliveryId);
    node?.focus({ preventScroll: true });
  };
  const refresh = async () => { await Promise.allSettled([actions.messageView(key).refresh(), actions.catalog.refresh()]); };
  const review = async (delivery: GroupDelivery, checking = false) => {
    if (lock.current || view.group.archived || statuses.get(delivery.id) !== 'pending') return;
    const trigger = document.activeElement;
    lock.current = true; setBusy(true); patch(delivery, { processing: 'preview' });
    try {
      const preview = unwrapGroup(await actions.remote().reviewExport(key, delivery.id));
      if (!alive.current) return;
      patch(delivery, { identity: JSON.stringify([delivery.id, preview.deliveryRevision, preview.flowId, view.group.membershipRevision]), preview, selected: false, receipt: undefined, later: false, processing: undefined });
      await refresh();
      requestAnimationFrame(() => {
        if (document.activeElement !== trigger && document.activeElement !== document.body) return;
        const item = [...(region.current?.querySelectorAll<HTMLElement>('[data-group-export-review]') ?? [])].find(node => node.dataset.groupExportReview === delivery.id);
        item?.querySelector('pre')?.focus({ preventScroll: true });
      });
    } catch (error) {
      const conflict = hasOperationCode(error, 'conflict');
      if (alive.current) patch(delivery, { preview: undefined, selected: false,
        processing: undefined, receipt: checking ? 'uncertain' : conflict ? 'changed' : hasOperationCode(error, 'group-data-blocked') ? 'unavailable' : 'previewFailed' });
      if (conflict) await refresh();
    }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const decide = async (deliveries: GroupDelivery[], allow: boolean) => {
    if (lock.current || view.group.archived) return;
    const decisions = deliveries.flatMap(delivery => {
      const item = current(delivery);
      return item.preview && !item.receipt ? [{ delivery, preview: item.preview, identity: item.identity }] : [];
    });
    if (!decisions.length) return;
    const trigger = document.activeElement;
    lock.current = true; setBusy(true); setBatchSending(Boolean(allow));
    let completed = 0;
    for (const decision of decisions) {
      if (!alive.current) break;
      const { delivery, preview } = decision;
      // Discard the token before dispatch. Ambiguous acceptance can never reuse it.
      patch(delivery, { preview: undefined, selected: false, processing: 'decision' });
      let receipt: Receipt;
      try {
        const latest = currentView.current;
        const row = latest.deliveries.find(candidate => candidate.id === delivery.id);
        if (!row || identity(row, latest.group.membershipRevision) !== decision.identity ||
          groupExportReviewStatus(latest.group, latest.turns.find(turn => turn.id === row.turnId), row) !== 'pending') throw { code: 'dsh-bot/conflict' };
        unwrapGroup(await actions.remote().decideExport(key, delivery.id, preview.token, allow));
        receipt = allow ? 'sent' : 'rejected';
      } catch (error) { receipt = failure(error); }
      if (alive.current) patch(delivery, { receipt, processing: undefined });
      completed++;
      await refresh();
    }
    lock.current = false;
    if (alive.current) {
      setBusy(false); setBatchSending(false); setAnnouncement(t('groups.export.batchFinished', { count: completed }));
      requestAnimationFrame(() => {
        if (document.activeElement !== trigger && document.activeElement !== document.body) return;
        if (decisions.length === 1) focusReceipt(decisions[0]?.delivery.id ?? '');
        else region.current?.querySelector<HTMLElement>('[data-export-batch-summary]')?.focus({ preventScroll: true });
      });
    }
  };
  const discard = async (delivery: GroupDelivery) => {
    if (lock.current || view.group.archived || statuses.get(delivery.id) !== 'pending' || !delivery.exportFlowId || delivery.revision === undefined) return;
    const trigger = document.activeElement;
    lock.current = true; setBusy(true); patch(delivery, { preview: undefined, selected: false, processing: 'decision' });
    try { unwrapGroup(await actions.remote().discardExport(key, delivery.id, delivery.revision)); patch(delivery, { receipt: 'rejected', processing: undefined }); }
    catch (error) { patch(delivery, { receipt: failure(error), processing: undefined }); }
    finally { await refresh(); lock.current = false; if (alive.current) { setBusy(false); requestAnimationFrame(() => {
      if (document.activeElement === trigger || document.activeElement === document.body) focusReceipt(delivery.id);
    }); } }
  };
  const closeStale = async () => {
    if (lock.current || view.group.archived || !staleCount) return;
    const trigger = document.activeElement;
    lock.current = true; setBusy(true); setStaleResult(undefined);
    let result: StaleResult;
    try { result = unwrapGroup(await actions.remote().closeStaleExports(key, view.group.membershipRevision)); }
    catch (error) { result = hasOperationCode(error, 'conflict') ? 'conflict' : 'failed'; }
    await refresh();
    lock.current = false;
    if (!alive.current) return;
    setBusy(false); setStaleResult(result);
    requestAnimationFrame(() => {
      if (document.activeElement === trigger || document.activeElement === document.body) {
        region.current?.querySelector<HTMLElement>('[data-stale-exports-result]')?.focus({ preventScroll: true });
      }
    });
  };
  if (!rows.length && !staleCount && !staleResult) return null;
  const turns = [...new Set(rows.map(row => row.turnId))].sort((left, right) => (turnsById.get(right)?.createdAt ?? 0) - (turnsById.get(left)?.createdAt ?? 0));
  return <section ref={region} tabIndex={-1} className={styles.exportQueue} aria-label={t('groups.export.queue')} data-group-export-queue={view.group.id}>
    {rows.length > 0 && <div className={styles.exportQueueHeader}>
      <button type="button" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>{t('groups.export.queueCount', { count: pendingCount })}</button>
      <span tabIndex={-1} role="status" aria-live="polite" data-export-batch-summary="">{announcement}</span>
    </div>}
    {staleCount > 0 && <div className={styles.exportQueueExpired} data-group-expired-exports="" data-expired-count={staleCount}>
      <div className={styles.exportQueueExpiredCopy}><strong>{t('groups.export.expiredCount', { count: staleCount })}</strong><p>{t('groups.export.expiredReason')}</p></div>
      <button type="button" data-close-stale-exports="" disabled={busy || view.group.archived} onClick={() => { void closeStale(); }}>{t('groups.export.closeExpired')}</button>
    </div>}
    {staleResult && <p tabIndex={-1} role={typeof staleResult === 'string' ? 'alert' : 'status'} data-stale-exports-result=""
      data-closed-count={typeof staleResult === 'string' ? undefined : staleResult.closed}>
      {typeof staleResult === 'string' ? t(`groups.export.closeExpiredResult.${staleResult}`) : t('groups.export.closeExpiredResult.closed', { count: staleResult.closed })}
    </p>}
    {expanded && rows.length > 0 && <div id={listId} className={styles.exportQueueList}>
      <p>{t('groups.export.batchHint')}</p>
      {turns.map(turnId => {
        const turn = turnsById.get(turnId);
        const question = view.messages.find(message => message.id === turn?.inputMessageId)?.text;
        return <section key={turnId} className={styles.exportQueueTurn} aria-label={t('groups.export.round', { round: view.turns.findIndex(row => row.id === turnId) + 1 })}>
          <h4>{t('groups.export.round', { round: view.turns.findIndex(row => row.id === turnId) + 1 })}</h4>
          {question && <p className={styles.exportQueueQuestion}>{question}</p>}
          {rows.filter(row => row.turnId === turnId).map(delivery => {
            const item = current(delivery), preview = item.preview, receipt = item.receipt;
            if (item.later && !showLater && !receipt) return null;
            return <section key={delivery.id} className={styles.exportQueueItem} data-group-export-review={delivery.id}>
              <div className={styles.exportQueueHeader}>
                <strong>{nameOf(delivery)}</strong>
                {!receipt && <label><input type="checkbox" checked={Boolean(preview && item.selected)} disabled={busy || view.group.archived || !preview}
                  onChange={event => select(delivery, event.currentTarget.checked)} />{t('groups.export.select')}</label>}
              </div>
              {receipt && <p tabIndex={-1} role="status" data-export-receipt={delivery.id}>{t(`groups.export.receipt.${receipt}`)}</p>}
              {receipt === 'uncertain' && <button type="button" disabled={busy} onClick={() => {
                // A read-only fresh preview may restore the controls for a still-held reply.
                // Lost or already-dispatched operations never retry their old decision.
                if (statuses.get(delivery.id) === 'pending' && delivery.exportFlowId &&
                    item.identity === identity(delivery, view.group.membershipRevision)) void review(delivery, true);
                else void refresh();
              }}>{t('groups.export.checkReceipt')}</button>}
              {!receipt && item.processing && <p role="status">{t(item.processing === 'preview' ? 'groups.export.itemPreviewing' : 'groups.export.itemProcessing')}</p>}
              {!receipt && !preview && !item.processing && <button type="button" disabled={busy || view.group.archived} onClick={() => { void review(delivery); }}>{t('groups.export.review')}</button>}
              {!receipt && preview && <>
                <p>{t('groups.export.scope', { group: preview.groupName, members: preview.recipients.map(row => row.name).join('、') })}</p>
                <p>{t('groups.export.notice')}</p>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Complete private reply is keyboard-readable plain text, never Markdown. */}
                <pre tabIndex={0} className={styles.exportBody}>{preview.content}</pre>
                <div className={styles.exportQueueActions}>
                  <button type="button" disabled={busy || view.group.archived} onClick={() => { void decide([delivery], true); }}>{t('groups.export.allow')}</button>
                </div><p>{t('groups.export.policySettingsHint')}</p>
              </>}
              {!item.processing && (!receipt || receipt === 'changed' || receipt === 'unavailable' || receipt === 'previewFailed') && <div className={styles.exportQueueActions}>
                <button type="button" disabled={busy || view.group.archived || !preview && (!delivery.exportFlowId || delivery.revision === undefined)} onClick={() => { if (preview) void decide([delivery], false); else void discard(delivery); }}>{t('groups.export.reject')}</button>
                <button type="button" disabled={busy || view.group.archived} onClick={() => patch(delivery, { preview: undefined, selected: false, later: true, receipt: undefined })}>{t('groups.export.close')}</button>
                {receipt && <button type="button" disabled={busy || view.group.archived} onClick={() => { void review(delivery); }}>{t('groups.export.review')}</button>}
              </div>}
            </section>;
          })}
        </section>;
      })}
      {laterCount > 0 && <button type="button" onClick={() => setShowLater(value => !value)}>{t(showLater ? 'groups.export.hideLater' : 'groups.export.showLater', { count: laterCount })}</button>}
    </div>}
    {expanded && rows.length > 0 && <div className={styles.exportQueueActions}>
      {selected[0] && <span>{t('groups.export.round', { round: view.turns.findIndex(turn => turn.id === selected[0]?.turnId) + 1 })}</span>}
      {pendingCount > 0 && <button type="button" disabled={busy || view.group.archived || !selected.length} onClick={() => { void decide(selected, true); }}>{t(batchSending ? 'groups.export.batchSending' : 'groups.export.batchOnce', { count: selected.length })}</button>}
      <button type="button" disabled={busy || clearableReceipts.length === 0} onClick={() => {
        const ids = new Set(clearableReceipts.map(item => item.delivery.id));
        setItems(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.has(id))));
        setAnnouncement('');
      }}>{t('groups.export.clearReceipts')}</button>
    </div>}
  </section>;
}
