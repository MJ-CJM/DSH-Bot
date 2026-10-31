import { useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
type Locale = PropsLocale<'dsh-bot'>;
import type { GraphStatus, CopyReceipt } from '../../shared/reference-memory.js';
export function CopyView({
  copy,
  status,
  busy,
  stage,
  commit,
  rollback,
  t,
}: {
  copy: CopyReceipt;
  status?: GraphStatus;
  busy: boolean;
  stage(): void;
  commit(): void;
  rollback(): void;
} & Locale) {
  const [confirmed, setConfirmed] = useState<string>();
  const signature = JSON.stringify([copy.id, copy.sourceDigest, copy.records.length]);
  return (
    <section aria-label={t('graph.copy')}>
      <p>{t(`graph.phase-${copy.phase}`)}</p>
      <p>
        {t('graph.file')}: {copy.targetFileIdentity}.jsonl
      </p>
      <p>
        {t('graph.verifiedCount', {
          count: copy.records.filter((r) => r.status === 'verified').length,
          total: copy.records.length,
        })}
      </p>
      <ul>
        {copy.records.map((r) => (
          <li key={r.memoryId}>
            {r.memoryId} · {t(`graph.record-${r.status}`)}
          </li>
        ))}
      </ul>
      <label>
        <input
          type="checkbox"
          checked={confirmed === signature}
          onChange={(e) => setConfirmed(e.target.checked ? signature : undefined)}
        />
        {t('graph.confirmCount', { count: copy.records.length })}
      </label>
      <button
        type="button"
        disabled={busy || confirmed !== signature || !['preview', 'staging', 'failed'].includes(copy.phase)}
        onClick={stage}
      >
        {t('graph.stage')}
      </button>
      <button type="button" disabled={busy || copy.phase !== 'verified'} onClick={commit}>
        {t('graph.commit')}
      </button>
      <button
        type="button"
        disabled={
          busy || copy.phase === 'rolled-back' || (copy.phase === 'committed' && status?.binding?.importId !== copy.id)
        }
        onClick={rollback}
      >
        {t('graph.rollback')}
      </button>
    </section>
  );
}
