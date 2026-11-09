import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useState } from 'react';
import type { FeedbackWorkspaceActions } from './feedback-api.js';
import type { FeedbackCandidate } from '../../shared/proactive/feedback.js';
import type { BotKey } from '../../shared/identity.js';
import { methodPackage } from '../../shared/proactive/method-package.js';
export function MethodTransfer({ owner, candidates, actions, refresh, t }: PropsLocale<'dsh-bot'> & {
  owner: BotKey; candidates: FeedbackCandidate[]; actions: FeedbackWorkspaceActions; refresh(): Promise<void>;
}) {
  const [text, setText] = useState(''), [publicContent, setPublicContent] = useState(false);
  const [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [contract, setContract] = useState({ input: '', output: '', scope: '', forbidden: '' });
  const [pendingImport, setPendingImport] = useState<{ commandId: string; text: string }>();
  const rows = candidates.filter(row => row.proposal.kind === 'skill' && row.bodyPurgedAt === undefined);
  const candidate = rows.find(row => row.id === selected) ?? rows[0];
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(false); try { await action(); } catch { setError(true); } finally { setBusy(false); } };
  return <details><summary>{t('proactive.methodTransfer')}</summary>
    <p>{t('proactive.methodTransferHint')}</p>
    {error && <p role="alert">{t('proactive.feedbackFailed')}</p>}
    <select aria-label={t('proactive.feedbackSkillName')} value={candidate?.id ?? ''} onChange={e => setSelected(e.target.value)}>{rows.map(row => <option key={row.id} value={row.id}>{row.proposal.kind === 'skill' ? row.proposal.name : ''}</option>)}</select>
    {(['input', 'output', 'scope', 'forbidden'] as const).map(key => <label key={key}>{t(`proactive.methodContract.${key}`)}<textarea maxLength={1000} value={contract[key]} onChange={e => setContract({ ...contract, [key]: e.target.value })} /></label>)}
    <label><input type="checkbox" checked={publicContent} onChange={e => setPublicContent(e.target.checked)} />{t('proactive.methodPublic')}</label>
    <Button variant="ghost" disabled={busy || !!pendingImport || !candidate || !publicContent || Object.values(contract).some(value => !value.trim()) || !actions.exportMethod} onClick={() => { void run(async () => {
      if (!candidate || !actions.exportMethod) return;
      const result = await actions.exportMethod({ candidateId: candidate.id, expectedRevision: candidate.revision, contract, examples: [], publicContentConfirmed: true });
      setText(JSON.stringify(result, null, 2));
    }); }}>{t('proactive.methodExport')}</Button>
    <label>{t('proactive.methodPackage')}<textarea readOnly={!!pendingImport} maxLength={65536} value={text} onChange={e => setText(e.target.value)} /></label>
    <Button variant="ghost" disabled={busy || !text.trim() || !actions.importMethod} onClick={() => { void run(async () => {
      const request = pendingImport ?? { commandId: crypto.randomUUID(), text };
      const data = methodPackage.parse(JSON.parse(request.text));
      setPendingImport(request);
      const reply = await actions.importMethod?.({ commandId: request.commandId, owner, package: data });
      if (reply?.kind === 'unknown') throw new Error('Reconcile the same import');
      setPendingImport(undefined);
      if (reply?.kind !== 'receipt') throw new Error('Import rejected');
      await refresh();
    }); }}>{t(pendingImport ? 'proactive.feedbackReconcile' : 'proactive.methodImport')}</Button>
  </details>;
}
