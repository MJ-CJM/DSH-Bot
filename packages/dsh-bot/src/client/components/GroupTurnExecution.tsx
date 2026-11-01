import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupTurn, GroupView } from '../../shared/groups.js';
import { type GroupActions, unwrapGroup } from '../groups-state.js';
import type { BotCatalog } from '../state.js';
import type { ExecutionBridge } from '../group-execution.js';
import { GroupMemberProcess } from './GroupMemberProcess.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/groups.module.css';

/** One disclosure owned by the original question, never by its replies or the composer. */
export function GroupTurnExecution({ view, turn, actions, bots, onOpenExecution, executionBridge, renderFactorySlot, t }: {
  view: GroupView; turn: GroupTurn; actions: GroupActions; bots: BotCatalog;
  onOpenExecution(childId: string): void;
  executionBridge?: ExecutionBridge; renderFactorySlot?: PropsRenderFactories['renderFactorySlot'];
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
  const deliveries = [...new Map(view.deliveries.filter(row => row.turnId === turn.id && row.reasonCode !== 'message-published' && !row.joinedDeliveryId)
    .map(row => [row.childSessionId ?? row.id, row])).values()];
  const nameOf = (delivery: GroupView['deliveries'][number]) => botState.entries.find(row =>
    row.bot.id === delivery.bot.botId && row.bot.createdAt === delivery.bot.botCreatedAt)?.bot.name ??
    view.messages.find(message => message.speaker?.bot.botId === delivery.bot.botId && message.speaker.bot.botCreatedAt === delivery.bot.botCreatedAt)?.speaker?.name ?? delivery.bot.botId;
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
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      {t('groups.executionDetails')} · {t('groups.turnSummary', { count: turn.orderedMemberIds.length, state: t(`groups.${turn.state}`) })}
    </button>
    <div id={bodyId} hidden={!expanded}>
      {turn.state === 'paused' && <p role="status">{t('execution.budgetPaused')} <button type="button" disabled={disabled} onClick={() => {
        void perform(async () => unwrapGroup(await actions.remote().continueTurn(key, turn.id, turn.revision)));
      }}>{t('execution.continue')}</button></p>}
      {deliveries.map(delivery => <div key={delivery.childSessionId ?? delivery.id} className={styles.memberExecution} data-group-execution-card={delivery.id}>
        <div className={styles.delivery}>
        <BotAvatar bot={botState.entries.find(row => row.bot.id === delivery.bot.botId && row.bot.createdAt === delivery.bot.botCreatedAt)?.bot ?? { id: delivery.bot.botId }} size={22} />
        <strong>{nameOf(delivery)}</strong><span>{t(`groups.${delivery.state}`)}</span>
        {delivery.reasonCode && <span>{t(delivery.reasonCode === 'configured-timeout' ? 'execution.timeout' : delivery.reasonCode === 'user-member-stop' ? 'execution.memberStopped' : delivery.reasonCode === 'user-task-stop' ? 'execution.taskStopped' : delivery.state === 'unknown' ? 'execution.unknown' : 'execution.failed')}</span>}
        {delivery.childSessionId && <Button variant="ghost" onClick={() => { if (delivery.childSessionId) onOpenExecution(delivery.childSessionId); }}>{t('execution.viewDetails')}</Button>}
        {active && (delivery.state === 'running' || (turn.protocol === 2 && ['starting', 'pending'].includes(delivery.state))) && <Menu
          open={menu === delivery.id} onClose={() => setMenu(undefined)} align="end"
          anchor={<Button variant="ghost" disabled={disabled} aria-label={t('execution.memberActions', { name: nameOf(delivery) })} aria-expanded={menu === delivery.id} aria-haspopup="menu" onClick={() => setMenu(menu === delivery.id ? undefined : delivery.id)}>···</Button>}
          items={[...(delivery.state === 'running' ? [{ id: 'supplement', label: t('groups.supplement') }] : []), ...(turn.protocol === 2 ? [{ id: 'stop', label: t('execution.stopMember') }] : [])]}
          onSelect={id => { setMenu(undefined); if (id === 'supplement') supplement(delivery.id); else void perform(async () => unwrapGroup(await actions.remote().stopMember(key, turn.id, delivery.memberId, turn.revision))); }} />}

        </div>
        {expanded && delivery.childSessionId && executionBridge && renderFactorySlot && <GroupMemberProcess
          key={delivery.childSessionId} parentId={view.group.rootSessionId} childId={delivery.childSessionId}
          readyToRead={!['pending', 'starting'].includes(delivery.state)} bridge={executionBridge} renderFactorySlot={renderFactorySlot} t={t} />}
      </div>)}
      {active && <button type="button" disabled={disabled} onClick={() => {
        void perform(async () => unwrapGroup(await actions.remote().cancel(key, turn.id, turn.revision)));
      }}>{t('groups.cancelTurn')}</button>}
      {turn.protocol === 2 && <details className={styles.executionMeta}><summary>{t('execution.advanced')}</summary><p>{t('execution.allowance')} · {turn.automaticExecutions ?? 0} / {turn.continuationAllowance ?? 0}</p></details>}
      {failed && <p role="alert">{t('groups.conflict')}</p>}
    </div>
  </section>;
}
