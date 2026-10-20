import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { routineCreateSchema, type RoutineRecord, type RoutineRule, type RunRecord, type RunStatus } from '../../shared/automation.js';
import type { BotRecord } from '../../shared/schema.js';
import type { RoutineActions } from '../automation-state.js';
import { Modal } from './Modal.js';
import styles from '../styles/routines.module.css';
import css from '../styles/routines.module.css?inline';

type T = PropsLocale<'dsh-bot'>['t'];
const statusKeys = { queued: 'routine.status.queued', running: 'routine.status.running', waiting_approval: 'routine.status.waiting_approval', succeeded: 'routine.status.succeeded', failed: 'routine.status.failed', cancelled: 'routine.status.cancelled', timed_out: 'routine.status.timed_out', skipped: 'routine.status.skipped', recovery_needed: 'routine.status.recovery_needed' } as const;
export function runStatus(status: RunStatus | undefined, t: T) { return t(status ? statusKeys[status] : 'routine.unknown'); }
export function routineRuleLabel(rule: RoutineRule, timeZone: string, t: T): string {
  switch (rule.kind) {
    case 'at': return `${t('routine.kind.at')} · ${formatTime(rule.at, timeZone, t)}`;
    case 'every': return t('routine.everySummary', { seconds: rule.everySeconds });
    case 'daily': return `${t('routine.kind.daily')} · ${rule.time}`;
    case 'weekly': return `${t('routine.kind.weekly')} · ${rule.weekdays.map(day => t(`routine.day.${day}` as 'routine.day.1')).join(', ')} · ${rule.time}`;
    case 'cron': return `${t('routine.kind.cron')} · ${rule.expression}`;
  }
}
function formatTime(at: number | undefined, timeZone: string, t: T) {
  return at === undefined ? t('routine.none') : new Intl.DateTimeFormat(t('activity.locale'), { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
function errorText(error: unknown, t: T) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === 'automation/conflict' ? t('routine.conflict') : `${t('routine.error')}${code ? ` (${code})` : ''}`;
}
type Dialog = { kind: 'edit'; record?: RoutineRecord } | { kind: 'delete' | 'run'; record: RoutineRecord; operationId?: string };
export function RoutinePanel({ actions, bots, botId, onOpenSession, t }: {
  actions: RoutineActions; bots: readonly BotRecord[]; botId?: string; onOpenSession(id: string): Promise<void>; t: T;
}) {
  const data = useSyncExternalStore(actions.catalog.subscribe, actions.catalog.getSnapshot);
  const [dialog, setDialog] = useState<Dialog>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const records = data.routines.filter(r => !botId || r.botId === botId);
  const writable = data.loaded && !data.error && data.status?.state === 'ready';
  async function perform(action: () => Promise<void>, accepted = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await action();
      if (alive.current) { setDialog(undefined); if (accepted) setNotice(t('routine.accepted')); }
    } catch (error) { if (alive.current) setError(errorText(error, t)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function open(next: Dialog) { setError(''); setNotice(''); setDialog(next); }
  const selectedRecord = records.find(r => r.id === selected);
  return <section className={styles.panel} data-routine-panel={botId ?? 'overview'} aria-label={t('routine.title')}>
    <style>{css}</style>
    <header className={styles.header}><div><h3>{t('routine.title')}</h3><p>{t('routine.hint')}</p></div>
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { void actions.catalog.refresh(); }}>{t('bots.refresh')}</button>
        <button type="button" disabled={!writable || busy || !bots.length} onClick={() => open({ kind: 'edit' })}>{t('routine.create')}</button></div></header>
    {!data.loaded && !data.error && <p role="status">{t('routine.loading')}</p>}
    {data.error && <p role="alert">{errorText(data.error, t)}</p>}
    {data.status && data.status.state !== 'ready' && <p role="alert">{t(data.status.state === 'read_only' ? 'routine.readOnly' : 'routine.unavailable')}</p>}
    {!dialog && error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {writable && records.length === 0 && <p>{t('routine.empty')}</p>}
    <div className={styles.list}>{records.map(record => {
      const last = data.lastRuns.find(run => run.routineId === record.id);
      return <article className={styles.card} key={record.id} data-routine-id={record.id}>
        <div className={styles.header}><button type="button" className={styles.title} aria-expanded={selected === record.id}
          onClick={() => setSelected(selected === record.id ? undefined : record.id)}>{record.title}</button>
          <span>{bots.find(bot => bot.id === record.botId)?.name ?? record.botId}</span></div>
        <p>{routineRuleLabel(record.rule, record.timeZone, t)} · {record.timeZone}</p>
        <div className={styles.meta}><span>{t(record.enabled ? 'routine.enabled' : 'routine.paused')}</span>
          <span>{t('routine.next')}: {formatTime(record.nextRunAt, record.timeZone, t)}</span>
          <span>{t('routine.last')}: {runStatus(last?.status, t)}</span></div>
        <div className={styles.actions}>
          <button type="button" disabled={!writable || busy} onClick={() => { void perform(() => actions.update(record, { enabled: !record.enabled })); }}>{t(record.enabled ? 'routine.pause' : 'routine.resume')}</button>
          <button type="button" disabled={!writable || busy} onClick={() => open({ kind: 'run', record, operationId: crypto.randomUUID() })}>{t('routine.runNow')}</button>
          <button type="button" disabled={!writable || busy} onClick={() => open({ kind: 'edit', record })}>{t('card.edit')}</button>
          <button type="button" disabled={!writable || busy} onClick={() => open({ kind: 'delete', record })}>{t('actions.delete')}</button>
          <button type="button" onClick={() => setSelected(selected === record.id ? undefined : record.id)}>{t('routine.history')}</button>
        </div>
      </article>;
    })}</div>
    {selectedRecord && <RoutineHistory key={selectedRecord.id} actions={actions} record={selectedRecord} onOpenSession={onOpenSession} t={t} />}
    {dialog?.kind === 'edit' && <RoutineEditor record={dialog.record} botId={botId} bots={bots} busy={busy} error={error} t={t}
      onClose={() => setDialog(undefined)} onSave={input => perform(() => {
        if (!dialog.record) return actions.create(input);
        const { botId: _bot, ...fields } = input;
        const patch: import('../../shared/automation.js').RoutinePatch = fields;
        // Unchanged time rules must not reset the schedule's anchor.
        if (JSON.stringify(patch.rule) === JSON.stringify(dialog.record.rule)) delete patch.rule;
        return actions.update(dialog.record, patch);
      })} />}
    {(dialog?.kind === 'delete' || dialog?.kind === 'run') && <Modal title={t(dialog.kind === 'delete' ? 'routine.deleteTitle' : 'routine.runNow')} busy={busy} onClose={() => setDialog(undefined)} t={t}>
      <div className={styles.form}><p>{dialog.record.title}</p><p>{t(dialog.kind === 'delete' ? 'routine.deleteConfirm' : 'routine.runConfirm')}</p>
        {error && <p role="alert">{error}</p>}
        <button type="button" disabled={busy || !writable} onClick={() => { void perform(() => dialog.kind === 'delete'
          ? actions.remove(dialog.record) : actions.runNow(dialog.record.id, dialog.operationId as string), dialog.kind === 'run'); }}>{t('routine.confirm')}</button>
      </div>
    </Modal>}
  </section>;
}

function RoutineHistory({ actions, record, onOpenSession, t }: { actions: RoutineActions; record: RoutineRecord; onOpenSession(id: string): Promise<void>; t: T }) {
  const [source] = useState(() => actions.history(record.id));
  const data = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [error, setError] = useState('');
  useEffect(() => () => source.dispose(), [source]);
  return <section className={styles.history} data-routine-history="" aria-label={t('routine.history')}><h4>{record.title} · {t('routine.history')}</h4>
    <p className={styles.prompt}>{record.prompt}</p><p>{t('routine.policy')}: {t(record.misfirePolicy === 'latest' ? 'routine.latest' : 'routine.skip')}</p>
    {!data.loaded && !data.error && <p role="status">{t('routine.loading')}</p>}
    {(data.error || error) && <p role="alert">{error || errorText(data.error, t)}</p>}
    <button type="button" onClick={() => { void source.refresh(); }}>{t('bots.refresh')}</button>
    {data.loaded && data.runs.length === 0 && <p>{t('routine.noHistory')}</p>}
    {data.runs.map(run => <article key={run.id} className={styles.card} data-run-id={run.id}>
      <div className={styles.header}><strong>{runStatus(run.status, t)}</strong><time>{formatTime(run.requestedAt, run.snapshot.timeZone, t)}</time></div>
      <p>{t('routine.trigger')}: {t(run.trigger === 'scheduled' ? 'routine.scheduled' : run.trigger === 'manual' ? 'routine.manual' : 'routine.delegate')}</p>
      {run.skipReason && <p>{t('routine.skipReason')}: {skipReason(run.skipReason, t)}</p>}
      {run.errorCode && <p>{t('routine.failure')}: {run.errorCode}</p>}
      <p>{t('routine.scheduledAt')}: {formatTime(run.scheduledAt, run.snapshot.timeZone, t)} · {t('routine.startedAt')}: {formatTime(run.startedAt, run.snapshot.timeZone, t)}</p>
      <details><summary>{t('routine.snapshot')}</summary><p>{run.snapshot.title} · {run.snapshot.presetId} · {run.snapshot.timeZone}</p><p className={styles.prompt}>{run.snapshot.prompt}</p></details>
      {run.summary && <p className={styles.prompt}>{run.summary}</p>}
      {hasSession(run) && <button type="button" onClick={() => { void onOpenSession(run.sessionId).catch(() => setError(t('activity.openError'))); }}>{t('routine.openSession')}</button>}
    </article>)}
    {data.more && <button type="button" onClick={() => { void source.loadMore(); }}>{t('routine.more')}</button>}
  </section>;
}
function hasSession(run: RunRecord) { return Boolean(run.workspaceId) && !['queued', 'reserved'].includes(run.step); }
function skipReason(reason: string, t: T) {
  const keys = { overlap: 'routine.reason.overlap', quota: 'routine.reason.quota', catch_up_expired: 'routine.reason.catch_up_expired', misfire: 'routine.reason.misfire', superseded: 'routine.reason.superseded', queue_full: 'routine.reason.queue_full' } as const;
  return reason in keys ? t(keys[reason as keyof typeof keys]) : reason;
}

type EditorInput = Parameters<RoutineActions['create']>[0];
function RoutineEditor({ record, botId, bots, busy, error, onSave, onClose, t }: {
  record?: RoutineRecord; botId?: string; bots: readonly BotRecord[]; busy: boolean; error: string;
  onSave(input: EditorInput): Promise<void>; onClose(): void; t: T;
}) {
  const uid = useId();
  const [target, setTarget] = useState(record?.botId ?? botId ?? bots[0]?.id ?? '');
  const [title, setTitle] = useState(record?.title ?? '');
  const [prompt, setPrompt] = useState(record?.prompt ?? '');
  const [zone, setZone] = useState(record?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [kind, setKind] = useState<RoutineRule['kind']>(record?.rule.kind ?? 'daily');
  const [seconds, setSeconds] = useState(record?.rule.kind === 'every' ? String(record.rule.everySeconds) : '3600');
  const [at, setAt] = useState(record?.rule.kind === 'at' ? new Date(record.rule.at).toISOString() : '');
  const [time, setTime] = useState(record?.rule.kind === 'daily' || record?.rule.kind === 'weekly' ? record.rule.time : '09:00:00');
  const [weekdays, setWeekdays] = useState(record?.rule.kind === 'weekly' ? record.rule.weekdays : [1]);
  const [expression, setExpression] = useState(record?.rule.kind === 'cron' ? record.rule.expression : '0 9 * * 1-5');
  const [enabled, setEnabled] = useState(record?.enabled ?? true);
  const [policy, setPolicy] = useState<'latest' | 'skip'>(record?.misfirePolicy ?? 'latest');
  const [invalid, setInvalid] = useState(false);
  return <Modal title={t(record ? 'routine.edit' : 'routine.create')} busy={busy} onClose={onClose} t={t}>
    <form className={styles.form} onSubmit={event => {
      event.preventDefault();
      const rule = kind === 'at' ? { kind, at: /(?:Z|[+-]\d{2}:\d{2})$/i.test(at) ? Date.parse(at) : Number.NaN }
        : kind === 'every' ? { kind, everySeconds: Number(seconds) }
          : kind === 'cron' ? { kind, expression }
            : kind === 'daily' ? { kind, time: time.length === 5 ? `${time}:00` : time }
              : { kind, weekdays, time: time.length === 5 ? `${time}:00` : time };
      const parsed = routineCreateSchema.safeParse({ botId: target, title, prompt, timeZone: zone, rule, enabled, misfirePolicy: policy });
      setInvalid(!parsed.success);
      if (parsed.success) void onSave(parsed.data);
    }}>
      <fieldset disabled={busy}>
        <div className={styles.field}><label htmlFor={`${uid}-bot`}>{t('routine.bot')}</label>
          <select id={`${uid}-bot`} value={target} disabled={Boolean(record || botId)} onChange={event => setTarget(event.target.value)}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></div>
        <div className={styles.field}><label htmlFor={`${uid}-name`}>{t('routine.name')}</label>
          <input id={`${uid}-name`} required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></div>
        <div className={styles.field}><label htmlFor={`${uid}-prompt`}>{t('routine.prompt')}</label>
          <textarea id={`${uid}-prompt`} required rows={4} maxLength={65536} value={prompt} onChange={event => setPrompt(event.target.value)} /></div>
        <div className={styles.field}><label htmlFor={`${uid}-rule`}>{t('routine.rule')}</label>
          <select id={`${uid}-rule`} value={kind} onChange={event => setKind(event.target.value as RoutineRule['kind'])}>{(['at', 'every', 'daily', 'weekly', 'cron'] as const).map(value => <option key={value} value={value}>{t(`routine.kind.${value}`)}</option>)}</select></div>
        <div className={styles.field}><label htmlFor={`${uid}-zone`}>{t('routine.timeZone')}</label>
          <input id={`${uid}-zone`} required value={zone} onChange={event => setZone(event.target.value)} /></div>
        {kind === 'at' && <div className={styles.field}><label htmlFor={`${uid}-at`}>{t('routine.at')}</label>
          <input id={`${uid}-at`} required placeholder="2027-01-01T09:00:00+08:00" value={at} onChange={event => setAt(event.target.value)} /></div>}
        {kind === 'every' && <div className={styles.field}><label htmlFor={`${uid}-seconds`}>{t('routine.seconds')}</label>
          <input id={`${uid}-seconds`} type="number" required min={60} step={1} value={seconds} onChange={event => setSeconds(event.target.value)} /></div>}
        {(kind === 'daily' || kind === 'weekly') && <div className={styles.field}><label htmlFor={`${uid}-time`}>{t('routine.time')}</label>
          <input id={`${uid}-time`} required value={time} onChange={event => setTime(event.target.value)} /></div>}
        {kind === 'weekly' && <fieldset><legend>{t('routine.weekdays')}</legend><div className={styles.actions}>{[1, 2, 3, 4, 5, 6, 7].map(day => <div className={styles.field} key={day}>
          <label htmlFor={`${uid}-day-${day}`}>{t(`routine.day.${day}` as 'routine.day.1')}</label>
          <input id={`${uid}-day-${day}`} type="checkbox" checked={weekdays.includes(day)} onChange={event => setWeekdays(event.target.checked ? [...weekdays, day].sort() : weekdays.filter(value => value !== day))} /></div>)}</div></fieldset>}
        {kind === 'cron' && <div className={styles.field}><label htmlFor={`${uid}-cron`}>{t('routine.cron')}</label>
          <input id={`${uid}-cron`} required value={expression} onChange={event => setExpression(event.target.value)} /></div>}
        <div className={styles.field}><label htmlFor={`${uid}-policy`}>{t('routine.policy')}</label>
          <select id={`${uid}-policy`} value={policy} onChange={event => setPolicy(event.target.value as 'latest' | 'skip')}><option value="latest">{t('routine.latest')}</option><option value="skip">{t('routine.skip')}</option></select></div>
        <div className={styles.field}><label htmlFor={`${uid}-enabled`}>{t('routine.enabled')}</label>
          <input id={`${uid}-enabled`} type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /></div>
      </fieldset>
      <p>{t('routine.scheduleHint')}</p>{invalid && <p role="alert">{t('routine.invalid')}</p>}{error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{t('editor.save')}</button>
    </form>
  </Modal>;
}
