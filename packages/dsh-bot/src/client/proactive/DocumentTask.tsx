import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useState } from 'react';
import type { BotKey } from '../../shared/identity.js';
import { documentRequestSchema, type DocumentRequest } from '../../shared/proactive/document.js';
import type { SuggestionActionReply } from '../../shared/proactive/remote-contract.js';

/** Optional task input, inside the existing task page; no new configuration. */
export function DocumentTask({ owner, submit, refresh, t }: PropsLocale<'dsh-bot'> & {
  owner: BotKey; submit(input: DocumentRequest): Promise<SuggestionActionReply>; refresh?(): Promise<void>;
}) {
  const [name, setName] = useState(''), [content, setContent] = useState('');
  const [question, setQuestion] = useState(''), [acceptance, setAcceptance] = useState('');
  const [version, setVersion] = useState(1), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<'failed' | 'submitted' | 'unknown'>();
  const [unresolved, setUnresolved] = useState<DocumentRequest>();
  async function run() {
    if (busy) return;
    setBusy(true); setMessage(undefined);
    let request = unresolved;
    try {
      request ??= documentRequestSchema.parse({ commandId: crypto.randomUUID(), requestedAt: new Date().toISOString(), owner, approved: true,
        document: { kind: 'document-analysis', version: 1, name, sourceVersion: version, content, question, acceptance } });
      setUnresolved(request);
      const reply = await submit(request);
      if (reply.kind === 'unknown') { setMessage('unknown'); return; }
      setUnresolved(undefined);
      if (reply.kind !== 'receipt') { setMessage('failed'); return; }
      setMessage('submitted'); await refresh?.();
    } catch { setMessage(request ? 'unknown' : 'failed'); }
    finally { setBusy(false); }
  }
  return <details data-document-task>
    <summary>{t('proactive.documentTask')}</summary>
    <p>{t('proactive.documentHint')}</p>
    <fieldset disabled={busy || !!unresolved}>
      <label>{t('proactive.documentName')}<input value={name} maxLength={160} onChange={e => setName(e.target.value)} /></label>
      <label>{t('proactive.documentVersion')}<input type="number" min={1} step={1} value={version} onChange={e => setVersion(Number(e.target.value))} /></label>
      <label>{t('proactive.documentContent')}<textarea value={content} maxLength={8192} onChange={e => setContent(e.target.value)} /></label>
      <label>{t('proactive.documentQuestion')}<textarea value={question} maxLength={1000} onChange={e => setQuestion(e.target.value)} /></label>
      <label>{t('proactive.documentAcceptance')}<textarea value={acceptance} maxLength={500} onChange={e => setAcceptance(e.target.value)} /></label>
    </fieldset>
    <Button variant="ghost" disabled={busy || (!unresolved && (!name.trim() || !content.trim() || !question.trim() || !acceptance.trim()))} onClick={() => { void run(); }}>{t(unresolved ? 'proactive.feedbackReconcile' : 'proactive.documentSubmit')}</Button>
    {message && <p role="status">{t(`proactive.documentStatus.${message}`)}</p>}
  </details>;
}
