import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supportsWorkContinuation, type ProactiveWork, type WorkContinuationRequest } from '../../shared/proactive/work.js';
import type { SuggestionActionReply } from '../../shared/proactive/remote-contract.js';

export interface ContinuationControls {
  policyRevision: number;
  canLaunch: boolean;
  run(input: WorkContinuationRequest): Promise<SuggestionActionReply>;
}
type Draft = { action: 'mark-waiting'; reason: string; request: string }
  | { action: 'supplement'; text: string; approved: true }
  | { action: 'retry'; approved: true };

export function WorkContinuationControls({ row, pending, controls, t }: PropsLocale<'dsh-bot'> & {
  row: ProactiveWork; pending: boolean; controls?: ContinuationControls;
}) {
  const [reason, setReason] = useState(''), [request, setRequest] = useState(''), [text, setText] = useState('');
  const [unconfirmed, setUnconfirmed] = useState<WorkContinuationRequest>();
  const [feedback, setFeedback] = useState<'unknown' | 'rejected'>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const wait = row.state === 'delivered' ? row.wait : undefined;
  if (!supportsWorkContinuation(row) || !['delivered', 'failed'].includes(row.state)) return null;
  const canWrite = !!controls && !pending && !busy && !unconfirmed;
  const canStart = !!controls?.canLaunch && row.generation < (row.taskLimits?.maxAttempts ?? 3)
    && Date.parse(row.expiresAt) > Date.now()
    && (!row.taskLimits || Date.parse(row.taskLimits.deadlineAt) > Date.now());
  async function run(input: WorkContinuationRequest) {
    if (!controls || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setFeedback(undefined);
    try {
      const reply = await controls.run(input);
      if (!mounted.current) return;
      if (reply.kind === 'unknown') {
        setUnconfirmed(input); setFeedback('unknown');
      } else {
        setUnconfirmed(undefined);
        if (reply.kind === 'rejected') setFeedback('rejected');
      }
    } catch {
      if (mounted.current) { setUnconfirmed(input); setFeedback('unknown'); }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit(event: FormEvent, draft: Draft) {
    event.preventDefault();
    if (!controls || !canWrite || (draft.action !== 'mark-waiting' && !canStart)) return;
    void run({ ...draft, commandId: crypto.randomUUID(), owner: row.target.bot, ticketId: row.ticketId,
      assignmentId: row.assignmentId, expectedRevision: row.revision, expectedPolicyRevision: controls.policyRevision });
  }
  return <section data-work-continuation="">
    {wait && <><p>{t('proactive.workWaitReason', { reason: wait.reason })}</p>
      <p>{t('proactive.workWaitRequest', { request: wait.request })}</p></>}
    {feedback && <p role="status">{t(feedback === 'unknown' ? 'followUp.unknown' : 'followUp.rejected')}</p>}
    {unconfirmed && <Button type="button" variant="ghost" disabled={busy || !controls}
      onClick={() => void run(unconfirmed)}>{t('followUp.recheck')}</Button>}
    {controls && row.state === 'delivered' && !wait && <details>
      <summary>{t('proactive.workMarkWaiting')}</summary>
      <form onSubmit={event => submit(event, { action: 'mark-waiting', reason: reason.trim(), request: request.trim() })}>
        <label>{t('followUp.waitReason')}<input required value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>
        <label>{t('followUp.waitRequest')}<textarea required value={request} maxLength={500} onChange={event => setRequest(event.target.value)} /></label>
        <Button type="submit" disabled={!canWrite || !reason.trim() || !request.trim()}>{t('proactive.workSaveWait')}</Button>
      </form>
    </details>}
    {controls && wait && canStart && <form onSubmit={event => submit(event, { action: 'supplement', text: text.trim(), approved: true })}>
      <label>{t('proactive.workSupplement')}<textarea required value={text} maxLength={2048} onChange={event => setText(event.target.value)} /></label>
      <Button type="submit" disabled={!canWrite || !text.trim()}>{t('proactive.workContinue')}</Button>
    </form>}
    {controls && row.state === 'failed' && canStart && <form onSubmit={event => submit(event, { action: 'retry', approved: true })}>
      <p>{t('proactive.workRetryHint')}</p>
      <Button type="submit" disabled={!canWrite}>{t('proactive.workRetry')}</Button>
    </form>}
  </section>;
}
