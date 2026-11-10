import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { subjectKey, type FollowUpAction, type FollowUpCard, type FollowUpOrigin, type Subject } from '../../shared/proactive/follow-up.js';
import { GroupFollowUpContinue, type GroupFollowUpMember, type GroupFollowUpTransport } from './GroupFollowUpContinue.js';
import { useFollowUpCatalog, useFollowUpVisibility, type FollowUpCommand, type FollowUpSource } from './follow-up-state.js';
import styles from './follow-up.module.css';
import css from './follow-up.module.css?inline';

type Locale = PropsLocale<'dsh-bot'>;
export interface FollowUpNavigation {
  canOpen(origin: FollowUpOrigin): boolean;
  open(origin: FollowUpOrigin, signal: AbortSignal): void | Promise<void>;
}
interface PanelProps extends Locale {
  source: FollowUpSource;
  subject: Subject;
  mode: 'summary' | 'detail';
  active?: boolean;
  editable?: boolean;
  navigation?: FollowUpNavigation;
  groupContinuation?: {
    members: readonly GroupFollowUpMember[];
    transport: GroupFollowUpTransport;
    canContinue(turnId: string): boolean;
    onAccepted(turnId: string): void;
  };
  onShowAll?(): void;
  advanced?(allowed: boolean): ReactNode;
}
const openRows = (rows: readonly FollowUpCard[]) => rows.filter(row => row.state === 'open');

export function FollowUpPanel(props: PanelProps) {
  // An in-flight response, form or cursor belongs to a single generation.
  return <ScopedPanel key={subjectKey(props.subject)} {...props} />;
}

function ScopedPanel({ source, subject, mode, active = true, editable = true, navigation, groupContinuation, onShowAll, advanced, t }: PanelProps) {
  const visible = useFollowUpVisibility() && active;
  const summary = source.summary(subject), firstPage = source.firstPage(subject);
  const { status, error: summaryError } = useFollowUpCatalog(summary, visible);
  const details = mode === 'detail' && status?.state === 'ready';
  const { page, error: pageError } = useFollowUpCatalog(firstPage, visible && details);
  const [loadedPage, setLoadedPage] = useState<{ base: typeof page; rows: FollowUpCard[]; next?: string }>();
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [feedback, setFeedback] = useState<'unknown' | 'rejected' | 'openFailed' | 'pageFailed'>();
  const lifetime = useRef(new AbortController());
  const titleId = useId();
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    if (!visible) controller.abort();
    return () => controller.abort();
  }, [visible]);
  const ready = status?.state === 'ready' ? status : undefined;
  const policy = ready?.summary.policy;
  const legacyCi = ready?.summary.legacyCiActive ?? false;
  const enabled = !!policy?.localEnabled || legacyCi;
  const pending = source.pending(subject);
  const canChange = visible && editable && !busy && !summaryError && !pending
    && (status?.state === 'disabled' || status?.state === 'ready');
  const canForget = visible && !!ready && !busy && !summaryError && !pending;
  const activePage = loadedPage?.base === page ? loadedPage : undefined;
  const next = activePage ? activePage.next : page?.next;
  const allRows = [...(page?.rows ?? []), ...(activePage?.rows ?? [])];
  const rows = mode === 'summary' ? openRows(ready?.summary.rows ?? []).slice(0, 3)
    : history ? allRows : openRows(allRows);
  const statusText = summaryError || status?.state === 'unavailable' ? 'followUp.unavailable'
    : !status ? 'followUp.loading'
    : enabled ? legacyCi ? policy?.localEnabled ? 'followUp.enabledWithCi' : 'followUp.legacyCi' : 'followUp.enabled'
    : policy?.legacyCi === 'denied' ? 'followUp.paused' : 'followUp.off';
  const refresh = async () => {
    if (!lifetime.current.signal.aborted) await Promise.all([summary.refresh(), ...(details ? [firstPage.refresh()] : [])]);
  };
  const run = async (command: FollowUpCommand) => {
    const forgetting = command.kind === 'card' && command.input.action === 'forget';
    if (busyRef.current || (!editable && !forgetting)) return;
    const { signal } = lifetime.current;
    if (signal.aborted) return;
    busyRef.current = true; setBusy(true); setFeedback(undefined);
    try {
      const reply = await source.run(command);
      if (forgetting && reply.kind === 'receipt') setLoadedPage(undefined);
      if (signal.aborted) return;
      setFeedback(reply.kind === 'receipt' ? undefined : reply.kind);
      if (reply.kind === 'receipt' && command.kind === 'watch') setAdding(false);
      setLoadedPage(undefined);
      await refresh();
    } finally {
      busyRef.current = false;
      // Reset this retained view even if it was hidden while the mutation ran.
      setBusy(false);
    }
  };
  const more = async () => {
    if (!next || busyRef.current || lifetime.current.signal.aborted) return;
    const { signal } = lifetime.current;
    busyRef.current = true; setBusy(true); setFeedback(undefined);
    try {
      const result = await source.page({ subject, cursor: next });
      if (signal.aborted || firstPage.getSnapshot().page !== page) return;
      const known = new Set(allRows.map(row => row.id));
      setLoadedPage({ base: page, next: result.next, rows: [...(activePage?.rows ?? []), ...result.rows.filter(row => !known.has(row.id))] });
    } catch {
      if (!signal.aborted) setFeedback('pageFailed');
    } finally { busyRef.current = false; setBusy(false); }
  };
  const open = async (origin: FollowUpOrigin) => {
    const { signal } = lifetime.current;
    if (!navigation || signal.aborted) return;
    setFeedback(undefined);
    try { await navigation.open(origin, signal); }
    catch { if (!signal.aborted) setFeedback('openFailed'); }
  };
  const editCard = (row: FollowUpCard, action: FollowUpAction['action']) => {
    if (!policy || (action === 'forget' ? !canForget : !policy.localEnabled || !canChange)) return;
    void run({ kind: 'card', input: { commandId: crypto.randomUUID(), subject, cardId: row.id,
      expectedRevision: row.revision, expectedPolicyRevision: policy.revision, action } });
  };
  return <section data-follow-up={mode} aria-labelledby={titleId} className={styles.section}>
    <style>{css}</style>
    <header className={styles.header}>
      <div><h3 id={titleId}>{t('followUp.title')}</h3><p role="status">{t(statusText)}</p></div>
      {editable && (status?.state === 'disabled' || ready) && <Button size="sm" variant={enabled ? 'ghost' : 'primary'} disabled={!canChange}
        onClick={() => void run({ kind: 'policy', input: {
          commandId: crypto.randomUUID(), subject, action: enabled ? 'pause' : 'enable-local',
          expectedRevision: policy?.revision ?? null, expectedConfigEpoch: status?.configEpoch ?? null,
        } })}>{t(busy ? 'followUp.saving' : enabled ? 'followUp.pause' : 'followUp.enable')}</Button>}
    </header>
    {(pending && !busy || feedback === 'unknown') && <div className={styles.notice} role="status">
      <p>{t('followUp.unknown')}</p>
      {pending && <Button size="sm" variant="ghost" disabled={!visible || busy ||
        (!editable && !(pending.kind === 'card' && pending.input.action === 'forget'))}
        onClick={() => void run(pending)}>{t('followUp.recheck')}</Button>}
    </div>}
    {feedback && feedback !== 'unknown' && <p className={styles.notice} role="alert">{t(`followUp.${feedback}`)}</p>}
    {(summaryError || pageError || feedback === 'pageFailed' || status?.state === 'unavailable') &&
      <Button size="sm" variant="ghost" disabled={!visible || busy} onClick={() => {
        setLoadedPage(undefined);
        setFeedback(undefined);
        void refresh();
      }}>{t('followUp.refresh')}</Button>}
    {details && <Button size="sm" variant="ghost" aria-pressed={history} onClick={() => setHistory(value => !value)}>
      {t('followUp.history')}
    </Button>}
    {rows.length > 0 && <ul className={styles.rows}>{rows.map(row => <FollowUpRow key={row.id} row={row}
      detail={mode === 'detail'} editCard={editCard} canChange={canChange && !!policy?.localEnabled}
      canForget={canForget}
      continuation={mode === 'detail' && subject.kind === 'group' && row.origin.kind === 'group-turn' &&
        row.condition.kind === 'failed' && row.state === 'open' && policy && groupContinuation?.canContinue(row.origin.turnId) &&
        <GroupFollowUpContinue subject={subject} cardId={row.id} turnId={row.origin.turnId} revision={row.revision}
          policyRevision={policy.revision} members={groupContinuation.members} active={visible}
          enabled={canChange && policy.localEnabled} transport={groupContinuation.transport} onAccepted={turnId => {
            groupContinuation.onAccepted(turnId);
            void refresh().catch(() => {});
          }} onAbandoned={() => void refresh().catch(() => {})} t={t} />}
      open={navigation?.canOpen(row.origin) ? () => void open(row.origin) : undefined} t={t} />)}</ul>}
    {enabled && rows.length === 0 && !summaryError && !pageError && (mode === 'summary' || page) &&
      <p className={styles.notice}>{t('followUp.empty')}</p>}
    {mode === 'summary' && onShowAll && ready && <Button size="sm" variant="ghost" onClick={onShowAll}>{t('followUp.viewAll')}</Button>}
    {details && next && <Button size="sm" variant="ghost" disabled={busy || !visible} onClick={() => void more()}>{t('followUp.more')}</Button>}
    {details && ready && policy?.localEnabled && editable && (adding ? <ManualWatchForm disabled={!canChange} onCancel={() => setAdding(false)}
      onAdd={watch => void run({ kind: 'watch', input: { commandId: crypto.randomUUID(), subject, id: crypto.randomUUID(),
        expectedRevision: ready.summary.policy.revision, watch } })} t={t} />
      : <Button size="sm" variant="outline" disabled={!canChange} onClick={() => setAdding(true)}>{t('followUp.add')}</Button>)}
    {advanced?.(!!ready && !ready.scopeOnly)}
  </section>;
}

function FollowUpRow({ row, detail, canChange, canForget, editCard, open, continuation, t }: Locale & {
  row: FollowUpCard;
  detail: boolean;
  canChange: boolean;
  canForget: boolean;
  editCard(row: FollowUpCard, action: FollowUpAction['action']): void;
  open?: () => void;
  continuation?: ReactNode;
}) {
  const condition = row.condition;
  return <li className={styles.row} data-follow-up-card={row.id}>
    <div className={styles.rowMain}>
      <strong>{row.title}</strong>
      <p className={styles.meta}>{t(`followUp.source.${row.origin.kind}`)} · {t(`followUp.condition.${condition.kind}`)}
        {row.state !== 'open' && <> · {t(`followUp.history.${row.state}`)}</>}</p>
      {detail && condition.kind === 'waiting-input' && <><p>{condition.wait.reason}</p><p>{condition.wait.request}</p></>}
      {detail && condition.kind === 'tracking' && condition.completion && <p>{t('followUp.completionValue', { value: condition.completion })}</p>}
      {detail && condition.kind === 'approval-pending' && <>
        <p>{t('followUp.completionValue', { value: condition.completion })}</p>
        {condition.wait && <><p>{condition.wait.reason}</p><p>{condition.wait.request}</p></>}
      </>}
      {detail && condition.kind === 'failed' && condition.reason && <p>{condition.reason}</p>}
      {detail && condition.kind === 'failed' && !!condition.members?.length && <details>
        <summary>{t('followUp.failures', { count: condition.members.length })}</summary>
        <ul>{condition.members.map(member => <li key={member.deliveryId}>{member.reason}</li>)}</ul>
      </details>}
      {detail && (condition.kind !== 'tracking' || row.origin.kind === 'watch') && <p>{t(`followUp.next.${condition.kind}`)}</p>}
    </div>
    {continuation && <div className={styles.continuation}>{continuation}</div>}
    {detail && <div className={styles.rowActions}>
      {open && <Button size="sm" variant="ghost" onClick={open}>{t('followUp.open')}</Button>}
      {row.state === 'open' && <>
        {row.origin.kind === 'watch' && (condition.kind === 'approval-pending'
          ? row.subject.kind === 'group' && <Button size="sm" variant="primary" disabled={!canChange}
            onClick={() => editCard(row, 'confirm-watch')}>{t('followUp.confirmWatch')}</Button>
          : <Button size="sm" variant="ghost" disabled={!canChange} onClick={() => editCard(row, 'complete')}>{t('followUp.complete')}</Button>)}
        <Button size="sm" variant="ghost" disabled={!canChange} onClick={() => editCard(row, 'ignore')}>{t('followUp.ignore')}</Button>
        <Button size="sm" variant="ghost" disabled={!canChange} onClick={() => editCard(row, 'stop')}>{t('followUp.stop')}</Button>
      </>}
      <Button size="sm" variant="ghost" disabled={!canForget} title={t('followUp.forgetScope')}
        onClick={() => editCard(row, 'forget')}>{t('followUp.forget')}</Button>
    </div>}
  </li>;
}

type WatchDraft = Extract<FollowUpCommand, { kind: 'watch' }>['input']['watch'];
function ManualWatchForm({ disabled, onCancel, onAdd, t }: Locale & {
  disabled: boolean;
  onCancel(): void;
  onAdd(watch: WatchDraft): void;
}) {
  const [title, setTitle] = useState(''), [completion, setCompletion] = useState('');
  const [reason, setReason] = useState(''), [request, setRequest] = useState('');
  const waiting = !!(reason.trim() || request.trim());
  const invalid = !title.trim() || !completion.trim() || waiting && (!reason.trim() || !request.trim());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || invalid) return;
    onAdd({ title: title.trim(), completion: completion.trim(), source: { kind: 'manual' },
      ...(waiting ? { wait: { reason: reason.trim(), request: request.trim() } } : {}) });
  };
  return <form className={styles.form} onSubmit={submit}>
    <fieldset disabled={disabled}>
      <legend>{t('followUp.add')}</legend>
      <label>{t('followUp.watchTitle')}<input required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>{t('followUp.watchCompletion')}<textarea required maxLength={500} rows={2} value={completion} onChange={event => setCompletion(event.target.value)} /></label>
      <details><summary>{t('followUp.waitFields')}</summary>
        <label>{t('followUp.waitReason')}<input required={waiting} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label>{t('followUp.waitRequest')}<textarea required={waiting} maxLength={500} rows={2} value={request} onChange={event => setRequest(event.target.value)} /></label>
      </details>
    </fieldset>
    <div className={styles.rowActions}>
      <Button type="submit" size="sm" variant="primary" disabled={disabled || invalid}>{t('followUp.save')}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t('actions.cancel')}</Button>
    </div>
  </form>;
}
