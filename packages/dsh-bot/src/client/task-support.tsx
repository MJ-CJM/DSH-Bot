import { useCallback, useEffect, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { taskSupportSchema, type TaskMaterialInput, type TaskResumeInput, type TaskSupport } from '../shared/task-materials.js';
import type { BotRecord } from '../shared/schema.js';
import type { IntegrationActions } from './integrations-state.js';
import { createChangeStream } from './change-stream.js';
import { ConnectorsPanel } from './components/ConnectorsPanel.js';

export interface TaskSupportActions {
  view(workId: string): Promise<TaskSupport>;
  add(input: TaskMaterialInput): Promise<TaskSupport>;
  resume(input: TaskResumeInput): Promise<TaskSupport>;
  pending(): Promise<TaskSupport[]>;
  subscribe?(listener: () => void): () => void;
}
export function createTaskSupportActions(ctx: Context, subscribe?: TaskSupportActions['subscribe']): TaskSupportActions {
  const remote = () => { const service = ctx.get('remote.dshBotSupergroup'); if (!service) throw new Error('Unavailable'); return service; };
  const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: unknown }) => { if (!result.ok) throw result.error; return result.value; };
  const listeners = new Set<() => void>();
  const stream = createChangeStream(ctx, () => { for (const listener of listeners) listener(); });
  ctx.effect(() => () => { listeners.clear(); void stream.stop(); }, 'dsh-bot: task support invalidation');
  return { subscribe(listener) {
    listeners.add(listener); stream.start(); const off = subscribe?.(listener);
    return () => { listeners.delete(listener); off?.(); if (!listeners.size) void stream.stop(); };
  },
    view: async workId => taskSupportSchema.parse(unwrap(await remote().taskSupport({ workId }))),
    add: async input => taskSupportSchema.parse(unwrap(await remote().addMaterial(input))),
    resume: async input => taskSupportSchema.parse(unwrap(await remote().resumeWork(input))),
    pending: async () => taskSupportSchema.array().parse(unwrap(await remote().pendingTasks())),
  };
}
export type TaskOrigin = Pick<TaskSupport, 'workId' | 'owner' | 'originSessionId' | 'inputMessageId'>;

export function createTaskOriginFocus() {
  let target: TaskOrigin | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => target,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(value?: TaskOrigin) {
      target = value;
      for (const listener of listeners) listener();
    },
  };
}

export function PendingTaskSupport({ actions, open, t }: PropsLocale<'dsh-bot'> & {
  actions: TaskSupportActions; open(origin: TaskOrigin): Promise<void>;
}) {
  const [rows, setRows] = useState<TaskSupport[]>([]), [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true, generation = 0;
    const refresh = () => { const epoch = ++generation; void actions.pending().then(value => {
      if (active && epoch === generation) { setRows(value); setFailed(false); }
    }, () => { if (active && epoch === generation) setFailed(true); }); };
    const off = actions.subscribe?.(refresh); refresh();
    return () => { active = false; off?.(); };
  }, [actions]);
  if (!rows.length && !failed) return null;
  return <section data-pending-task-support="" aria-label={t('taskSupport.pending')}>
    <h2>{t('taskSupport.pending')}</h2><p>{t('taskSupport.readReceipt')}</p>
    {rows.map(row => <p key={row.workId} data-pending-task-work={row.workId} data-pending-task-session={row.originSessionId}><Button variant="ghost" onClick={() => { const { workId, owner, originSessionId, inputMessageId } = row;
      void open({ workId, owner, originSessionId, inputMessageId }).catch(() => setFailed(true)); }}>
      {row.ownerName || row.owner.botId} · {t('taskSupport.openOrigin')} ({row.blockers.filter(item => ['ready', 'waiting'].includes(item.state)).length})
    </Button></p>)}
    {failed && <p role="alert">{t('supergroup.unavailable')}</p>}
  </section>;
}
type SupportPanelProps = PropsLocale<'dsh-bot'> & {
  workId: string; actions: TaskSupportActions; integrations?: IntegrationActions; bot?: BotRecord; refresh?(): Promise<void>; openSession?(id: string): Promise<void>; readOnly?: boolean;
};
/** A separate keyed lifetime prevents an old read, draft or operation from moving to another work. */
export function TaskSupportPanel(props: SupportPanelProps) {
  return <TaskSupportForm key={props.workId} {...props} />;
}
type SupportOperation = { add?: TaskMaterialInput; resume?: TaskResumeInput; stage: 'add' | 'resume' };
function TaskSupportForm({ workId, actions, integrations, bot, refresh, openSession, readOnly, t }: SupportPanelProps) {
  const [value, setValue] = useState<TaskSupport>(), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState(''), [text, setText] = useState(''), [file, setFile] = useState<{ name: string; text: string }>();
  const [selected, setSelected] = useState(''), [reading, setReading] = useState(false), [pending, setPending] = useState<SupportOperation>();
  const operation = useRef<SupportOperation | undefined>(undefined), lock = useRef(false), alive = useRef(true), fileEpoch = useRef(0);
  const latest = useRef<TaskSupport | undefined>(undefined), readEpoch = useRef(0), reload = useRef<(() => void) | undefined>(undefined);
  const accept = useCallback((next: TaskSupport) => {
    if (next.workId !== workId) throw new Error('Wrong task');
    if (latest.current && next.revision < latest.current.revision) return latest.current;
    latest.current = next; if (alive.current) setValue(next); return next;
  }, [workId]);
  const keep = (next: SupportOperation | undefined) => { operation.current = next; if (alive.current) setPending(next); };
  useEffect(() => {
    alive.current = true;
    const read = () => { if (lock.current) return; const ticket = ++readEpoch.current; void actions.view(workId).then(row => {
      if (alive.current && !lock.current && ticket === readEpoch.current && row.workId === workId) { accept(row); setFailed(false); }
    }, () => { if (alive.current && !lock.current && ticket === readEpoch.current) setFailed(true); }); };
    reload.current = read; const off = actions.subscribe?.(read); read();
    return () => { alive.current = false; readEpoch.current++; fileEpoch.current++; if (reload.current === read) reload.current = undefined; off?.(); };
  }, [actions, workId, accept]);
  const originalQuestion = value?.originalQuestion || value?.inputs[0]?.name || '';
  function source() : TaskMaterialInput['source'] | undefined {
    const input = value?.inputs.find(row => `input:${row.messageId}` === selected), ci = value?.ci.find(row => `ci:${row.id}` === selected);
    return selected === 'file' && file ? { kind: 'file', ...file }
      : input ? { kind: 'input-text', messageId: input.messageId, version: input.version }
        : ci ? { kind: 'github-ci', id: ci.id, version: ci.version } : undefined;
  }
  async function run(mode: 'continue' | 'refresh') {
    if (lock.current || !value) return; lock.current = true; readEpoch.current++; setBusy(true); setFailed(false);
    try {
      if (mode === 'refresh') { accept(await actions.view(workId)); return; }
      let active = operation.current, current = latest.current ?? value;
      if (!active) {
        const chosen = source();
        if (selected && !chosen) throw new Error('Material not ready');
        active = chosen ? { stage: 'add', add: { workId, expectedRevision: current.revision, operationId: crypto.randomUUID(),
          question: question.trim() || originalQuestion.slice(0, 1000), source: chosen } } : { stage: 'resume' };
        keep(active);
      }
      if (active.stage === 'add') {
        if (!active.add) throw new Error('Missing material operation');
        current = accept(await actions.add(active.add));
        if (!alive.current) return;
        setFile(undefined); setSelected('');
        active = { ...active, stage: 'resume' }; keep(active);
      }
      if (!active.resume) {
        active = { ...active, resume: { workId, expectedRevision: current.revision, operationId: crypto.randomUUID(),
          text: text.trim() || t('taskSupport.continueOriginal'), blockerIds: current.blockers.filter(row => ['waiting', 'ready'].includes(row.state)).map(row => row.id) } };
        keep(active);
      }
      accept(await actions.resume(active.resume!));
      if (!alive.current) return;
      keep(undefined); setQuestion(''); setText(''); await refresh?.();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'dsh-bot/invalid') keep(undefined);
      else if (['dsh-bot/conflict', 'dsh-bot/approval-denied', 'dsh-bot/not-found', 'dsh-bot/unavailable'].includes(String(code))) {
        // A definitive rejection is editable only after an authoritative read.
        // Transport/unknown results retain exactly the same operation and body.
        try { accept(await actions.view(workId)); keep(undefined); } catch { /* Keep the original operation while state is unknown. */ }
      }
      if (alive.current) setFailed(true);
    } finally { lock.current = false; if (alive.current) { setBusy(false); reload.current?.(); } }
  }
  return <section data-task-support={workId} aria-busy={busy || reading}>
    <p>{t('taskSupport.hint')}</p>
    {value && <>
      <p data-task-original-question="">{originalQuestion}</p>
      {value.blockers.filter(row => row.state !== 'superseded' && row.state !== 'continued').map(row => <p key={row.id} data-task-blocker={row.state}>
        <strong>{row.name || t('taskSupport.connection')}</strong> · {t(`taskSupport.${row.state}`)}
      </p>)}
      {integrations && bot && value.blockers.some(row => ['waiting', 'ready'].includes(row.state)) && <details><summary>{t('taskSupport.resolve')}</summary>
        <ConnectorsPanel actions={integrations} bots={[bot]} onOpenSession={async id => { if (!openSession) throw new Error('Unavailable'); await openSession(id); }} t={t} />
      </details>}
      <Button variant="ghost" disabled={busy} onClick={() => { void run('refresh'); }}>{t('bots.refresh')}</Button>
      {value.recovery && <div data-task-recovery={value.recovery.state}>
        <p role="status">{t(`taskSupport.recovery.${value.recovery.state}`)}</p>
        {value.recovery.holdsAgent && <p>{t('taskSupport.recovery.holdsAgent')}</p>}
        <details><summary>{t('taskSupport.recovery.capabilities')}</summary><p>{t('taskSupport.recovery.timerUnavailable')}</p>
          <p>{t('taskSupport.recovery.toolUnavailable')}</p></details>
      </div>}
      <p>{t('taskSupport.readers')}: {(value.readerNames || value.readers.map(row => row.botId)).join(', ')}</p>
      <ul>{value.materials.map(row => <li key={row.id} data-task-material={row.kind}><strong>{row.name}</strong><p>{row.question}</p></li>)}</ul>
      <fieldset disabled={busy || !!pending || readOnly}>
        <legend>{t('taskSupport.materials')}</legend>
        <label>{t('taskSupport.source')}<select data-task-source="" value={selected} onChange={event => {
          fileEpoch.current++; setReading(false); setFile(undefined); setSelected(event.target.value);
        }}>
          <option value="">{t('taskSupport.choose')}</option><option value="file">{t('taskSupport.file')}</option>
          {value.inputs.map(row => <option key={row.messageId} value={`input:${row.messageId}`}>{t('taskSupport.input')}: {row.name}</option>)}
          {value.ci.map(row => <option key={row.id} value={`ci:${row.id}`}>GitHub CI: {row.name}</option>)}
        </select></label>
        <label>{t('taskSupport.file')}<input data-task-file="" type="file" accept="text/*,.md,.json,.csv,.log" onChange={event => {
          const selectedFile = event.target.files?.[0], ticket = ++fileEpoch.current; setFile(undefined); setReading(false);
          if (!selectedFile) return;
          setSelected('file');
          if (selectedFile.size > 65536) { setFailed(true); return; }
          setReading(true);
          void selectedFile.text().then(content => {
            if (!alive.current || ticket !== fileEpoch.current) return;
            setReading(false);
            if (content.length > 16384 || !content.trim()) setFailed(true); else setFile({ name: selectedFile.name, text: content });
          }, () => { if (alive.current && ticket === fileEpoch.current) { setReading(false); setFailed(true); } });
        }} /></label>
        {file && <p data-task-selected-file="">{file.name} · {file.text.length} {t('taskSupport.characters')}</p>}
        <details data-task-support-advanced=""><summary>{t('taskSupport.advanced')}</summary>
          <label>{t('taskSupport.question')}<textarea value={question} placeholder={originalQuestion} maxLength={1000} onChange={event => setQuestion(event.target.value)} /></label>
          <label>{t('taskSupport.continueText')}<textarea value={text} maxLength={2048} onChange={event => setText(event.target.value)} /></label>
        </details>
      </fieldset>
      <Button data-task-continue="" disabled={readOnly || busy || reading || !!pending || !!selected && !source() || value.resumes.some(row => row.state !== 'queued')}
        onClick={() => { void run('continue'); }}>{t('taskSupport.continueOriginal')}</Button>
      {value.resumes.map(row => <p key={row.operationId} data-task-resume={row.state} role="status">{t(`taskSupport.${row.state}`)}</p>)}
      <details data-task-support-technical=""><summary>{t('execution.advanced')}</summary>
        <p>{workId} · v{value.revision}</p>
        {value.blockers.map(row => <p key={row.id}>{row.assignmentId} · v{row.desiredRevision} · {row.reason} · {t(`taskSupport.${row.state}`)}</p>)}
        {value.materials.map(row => <p key={row.id}><code>{row.citation}</code> · {row.sourceVersion}</p>)}
      </details>
    </>}
    {failed && <p role="alert">{t(pending ? 'taskSupport.unknownAction' : 'taskSupport.failed')}</p>}
    {pending && <Button data-task-reconcile="" disabled={busy} onClick={() => { void run('continue'); }}>{t('taskSupport.reconcile')}</Button>}
  </section>;
}
