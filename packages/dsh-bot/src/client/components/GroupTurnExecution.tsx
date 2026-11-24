import { defaultStatisticsTurn, statisticsDeliveries } from '../group-statistics.js';
import { RelayDetails } from './RelayDetails.js';
import { GroupMemberStatistics } from './GroupStatistics.js';
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { useCallback, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupTurn, GroupView } from '../../shared/groups.js';
import { sameBot } from '../../shared/identity.js';
import { groupExportReviewStatus } from '../../shared/group-export-review.js';
import { type GroupActions, unwrapGroup } from '../groups-state.js';
import type { BotCatalog } from '../state.js';
import type { ExecutionBridge } from '../group-execution.js';
import { GroupMemberProcess, GroupPermissionDenialProbe } from './GroupMemberProcess.js';
import { BotAvatar } from './BotAvatar.js';
import { groupFailureCode, groupFailureText } from '../group-failure.js';
import { groupMemoryWriteCounts, guestQuestionStatus } from '../group-management.js';
import { exportStatusKey, GroupTurnAttention, turnExportStatus } from './GroupExportReview.js';
import { GroupExportQueueLink } from './GroupExportQueue.js';
import styles from '../styles/groups.module.css';

/** One disclosure owned by the original question, never by its replies or the composer. */
export function GroupTurnExecution({ view, turn, actions, bots, onOpenExecution, executionBridge, renderFactorySlot, onStopTurn, onRequestSupplement, t }: {
  view: GroupView; turn: GroupTurn; actions: GroupActions; bots: BotCatalog;
  onOpenExecution(childId: string): void;
  executionBridge?: ExecutionBridge; renderFactorySlot?: PropsRenderFactories['renderFactorySlot'];
  onStopTurn?: (() => Promise<void>) | null;
  /** null suppresses group-root draft controls in a projected main conversation. */
  onRequestSupplement?: ((deliveryId: string) => void) | null;
} & PropsLocale<'dsh-bot'>) {
  const key = { groupId: view.group.id, groupCreatedAt: view.group.createdAt };
  const expansionKey = JSON.stringify([key.groupId, key.groupCreatedAt, turn.id]);
  const [choice, setChoice] = useState(() => actions.turnExpansion.get(expansionKey));
  const bodyId = useId();
  const botState = useSyncExternalStore(bots.subscribe, bots.getSnapshot);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const active = ['accepted', 'running', 'paused'].includes(turn.state);
  const expanded = choice ?? false;
  const [menu, setMenu] = useState<string>();
  const disabled = busy || view.group.archived || view.group.state !== 'ready';
  // A persistent worker can have several deliveries. Its native trace appears only once.
  const workers = statisticsDeliveries(view, turn.id);
  const deliveries = workers.map(row => row.delivery);
  const turnDeliveries = view.deliveries.filter(delivery => delivery.turnId === turn.id);
  const exportState = turnExportStatus(view.group, turn, turnDeliveries);
  const hasReview = turnDeliveries.some(delivery => groupExportReviewStatus(view.group, turn, delivery) === 'pending');
  const nameOf = (delivery: GroupView['deliveries'][number]) => botState.entries.find(row =>
    row.bot.id === delivery.bot.botId && row.bot.createdAt === delivery.bot.botCreatedAt)?.bot.name ??
    view.messages.find(message => message.speaker?.bot.botId === delivery.bot.botId && message.speaker.bot.botCreatedAt === delivery.bot.botCreatedAt)?.speaker?.name ?? (turn.guestQuestion && sameBot(turn.guestQuestion.bot, delivery.bot) ? turn.guestQuestion.name : delivery.bot.botId);
  // Only the latest question is observed while collapsed, bounding retained child histories.
  const latest = defaultStatisticsTurn(view.turns)?.id === turn.id;
  const [deniedChildren, setDeniedChildren] = useState<ReadonlySet<string>>(() => new Set());
  const reportDenial = useCallback((childId: string, denied: boolean) => setDeniedChildren(current => {
    if (current.has(childId) === denied) return current;
    const next = new Set(current); if (denied) next.add(childId); else next.delete(childId); return next;
  }), []);
  const deniedNames = [...new Set(deliveries.filter(delivery => delivery.childSessionId && deniedChildren.has(delivery.childSessionId)).map(nameOf))];
  const perform = async (work: () => Promise<unknown>) => {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setFailed(false);
    try {
      await work();
      await Promise.all([actions.messageView(key).refresh(), actions.catalog.refresh()]);
    } catch { setFailed(true); }
    finally { lock.current = false; setBusy(false); }
  };
  const supplement = (deliveryId: string) => {
    if (onRequestSupplement) { onRequestSupplement(deliveryId); return; }
    actions.patchDraft(view.group.rootSessionId, draft => ({ ...draft,
      followup: { turnId: turn.id, deliveryId }, replyTo: undefined, mentions: [], mentionBindings: [] }));
    const composer = [...document.querySelectorAll<HTMLElement>('[data-workspace-group-composer]')]
      .find(element => element.dataset.workspaceGroupComposer === view.group.rootSessionId);
    composer?.querySelector('textarea')?.focus();
  };
  return <section className={styles.inlineExecution} data-group-turn={turn.id} data-group-turn-state={turn.state}>
    <button type="button" className={styles.turnSummary} aria-expanded={expanded} aria-controls={bodyId} onClick={() => {
      actions.turnExpansion.set(expansionKey, !expanded); setChoice(!expanded);
    }}>
      <span className={styles.executionChevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span>{t(turn.guestQuestion?.via ? 'groups.relay.marker' : 'groups.executionDetails')}</span><span className={styles.turnSummaryState} data-group-guest-status={turn.guestQuestion && turn.id}>{guestQuestionStatus(view, turn, t) ?? t('groups.turnSummary', { count: turn.orderedMemberIds.length,
        state: t(exportState ?? `groups.${turn.state}`) })}{!turn.guestQuestion?.via && <GroupTurnAttention group={view.group} turn={turn} deliveries={turnDeliveries} t={t} />}</span>
    </button>
    {latest && !turn.guestQuestion && executionBridge && deliveries.map(delivery => delivery.childSessionId && !['pending', 'starting'].includes(delivery.state) &&
      <GroupPermissionDenialProbe key={delivery.childSessionId} parentId={view.group.rootSessionId} childId={delivery.childSessionId}
        bridge={executionBridge} onChange={reportDenial} />)}
    {latest && deniedNames.length > 0 && <p role="status" className={styles.permissionDenied} data-group-permission-denied="">
      {t('groups.permissionDenied', { names: new Intl.ListFormat(t('activity.locale'), { type: 'conjunction' }).format(deniedNames) })}</p>}
    {/* A failed member without a reply message would otherwise show its cause only inside the collapsed details. */}
    {deliveries.flatMap(delivery => delivery.state === 'failed' && delivery.failure && !delivery.outputMessageId ? [{ delivery, failure: delivery.failure }] : [])
      .map(({ delivery, failure }) => <p key={delivery.id} role="status" className={styles.memberFailure} data-group-member-failure={delivery.id}>
        {t('groups.memberFailed', { name: nameOf(delivery), reason: groupFailureText(failure, t) })}
        {groupFailureCode(failure) && <span className={styles.failureCode}>{groupFailureCode(failure)}</span>}
        {failure.requestId && <span>{t('groups.failureRequestId')} <code className={styles.failureRequestId}>{failure.requestId}</code></span>}
      </p>)}
    {!turn.guestQuestion?.via && !expanded && exportState === 'groups.export.pending' && <p role="status">{t('groups.export.pending')}</p>}
    {hasReview && <GroupExportQueueLink view={view} actions={actions} t={t} />}
    {exportState === 'groups.export.expiredStatus' && <GroupExportQueueLink view={view} actions={actions} stale t={t} />}
    {turn.memoryStatusOnly && <p role="status">{t('groups.memoryStatus.summary', groupMemoryWriteCounts(deliveries))}</p>}
    <div id={bodyId} hidden={!expanded}>
      {expanded && turn.guestQuestion?.via && <RelayDetails actions={actions} request={{ kind: 'group', group: key, turnId: turn.id }}
        revision={JSON.stringify([view.group.membershipRevision, turn.revision, ...turnDeliveries.map(d => d.revision)])} t={t} />}
      {turn.state === 'paused' && <p role="status">{t('execution.budgetPaused')} <button type="button" disabled={disabled} onClick={() => {
        void perform(async () => unwrapGroup(await actions.remote().continueTurn(key, turn.id, turn.revision)));
      }}>{t('execution.continue')}</button></p>}
      {deliveries.filter(delivery => !turn.guestQuestion?.via || (active && ['pending', 'starting', 'running'].includes(delivery.state))).map(delivery => {
        const exportStatus = exportStatusKey(view.group, turn, delivery);
        return <div key={delivery.childSessionId ?? delivery.id} className={styles.memberExecution} data-group-execution-card={delivery.id}>
        <div className={styles.delivery}>
        <BotAvatar bot={botState.entries.find(row => row.bot.id === delivery.bot.botId && row.bot.createdAt === delivery.bot.botCreatedAt)?.bot ?? { id: delivery.bot.botId }} size={22} />
        <strong>{nameOf(delivery)}</strong><span>{t(exportStatus ?? `groups.${delivery.state}`)}</span>
        {turn.memoryStatusOnly && <span>{t(`groups.memoryStatus.${delivery.memoryWriteStatus ?? 'unverified'}`)}</span>}
        {delivery.reasonCode && !exportStatus && <span>{t(delivery.reasonCode === 'configured-timeout' ? 'execution.timeout' : delivery.reasonCode === 'user-member-stop' ? 'execution.memberStopped' : delivery.reasonCode === 'user-task-stop' ? 'execution.taskStopped' : delivery.state === 'unknown' ? 'execution.unknown' : 'execution.failed')}</span>}
        {delivery.failure && <span className={styles.failureReason}>{groupFailureText(delivery.failure, t)}</span>}
        {delivery.failure?.requestId && <span>{t('groups.failureRequestId')} <code className={styles.failureRequestId}>{delivery.failure.requestId}</code></span>}
        {!turn.guestQuestion && delivery.childSessionId && <Button variant="ghost" onClick={() => { if (delivery.childSessionId) onOpenExecution(delivery.childSessionId); }}>{t('execution.viewDetails')}</Button>}
        {active && (delivery.state === 'running' || (turn.protocol === 2 && ['starting', 'pending'].includes(delivery.state))) && <Menu
          open={menu === delivery.id} onClose={() => setMenu(undefined)} align="end"
          anchor={<Button variant="ghost" disabled={disabled} aria-label={t('execution.memberActions', { name: nameOf(delivery) })} aria-expanded={menu === delivery.id} aria-haspopup="menu" onClick={() => setMenu(menu === delivery.id ? undefined : delivery.id)}>···</Button>}
          items={[...(delivery.state === 'running' && !turn.guestQuestion && onRequestSupplement !== null ? [{ id: 'supplement', label: t('groups.supplement') }] : []), ...(turn.protocol === 2 ? [{ id: 'stop', label: t('execution.stopMember') }] : [])]}
          onSelect={id => { setMenu(undefined); if (id === 'supplement') supplement(delivery.id); else void perform(async () => unwrapGroup(await actions.remote().stopMember(key, turn.id, delivery.memberId, turn.revision))); }} />}

        </div>

        {expanded && !turn.guestQuestion?.via && executionBridge?.statistics && workers.find(row => row.delivery.memberId === delivery.memberId)?.delivery === delivery && <GroupMemberStatistics bridge={executionBridge} parentId={view.group.rootSessionId} workers={workers.filter(row => row.delivery.memberId === delivery.memberId)} t={t} />}
        {expanded && !turn.guestQuestion && !turn.memoryStatusOnly && delivery.childSessionId && executionBridge && renderFactorySlot && <GroupMemberProcess
          key={delivery.childSessionId} parentId={view.group.rootSessionId} childId={delivery.childSessionId}
          readyToRead={!['pending', 'starting'].includes(delivery.state)} bridge={executionBridge} renderFactorySlot={renderFactorySlot} t={t} />}
      </div>})}
      {active && onStopTurn !== null && <button type="button" disabled={disabled} onClick={() => {
        void perform(async () => onStopTurn ? onStopTurn() : unwrapGroup(await actions.remote().cancel(key, turn.id, turn.revision)));
      }}>{t('execution.stopTurn')}</button>}
      {!turn.guestQuestion && turn.protocol === 2 && <details className={styles.executionMeta}><summary>{t('execution.advanced')}</summary><p>{t('execution.allowance')} · {turn.automaticExecutions ?? 0} / {turn.continuationAllowance ?? 0}</p></details>}
      {failed && <p role="alert">{t('groups.conflict')}</p>}
    </div>
  </section>;
}
