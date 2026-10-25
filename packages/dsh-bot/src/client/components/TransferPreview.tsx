import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkspaceActions } from '../workspace-state.js';
type Result = Extract<Awaited<ReturnType<WorkspaceActions['workspace']>>, { ok: true }>['value'];
type Preview = Extract<Result, { kind: 'preview' }>['preview'];
export function TransferPreview({
  review,
  busy,
  confirm,
  t,
}: PropsLocale<'dsh-bot'> & { review: Preview; busy: boolean; confirm(): void }) {
  return (
    <section aria-label={t('manage.preview')}>
      <p>
        {review.newId} · {t(review.phase === 'failed' ? 'manage.failedPhase' : `manage.${review.phase}`)}
      </p>
      <p>{t('manage.memoryCount', { count: review.memories })}</p>
      <ul>
        {review.files.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      <p>{t('manage.refsDisabled')}</p>
      <ul>
        {review.connectorRefs.map((ref) => (
          <li key={ref}>
            {ref}
            {review.missingConnectorRefs.includes(ref) ? ` · ${t('manage.unmapped')}` : ''}
          </li>
        ))}
      </ul>
      {review.conflict && <p role="alert">{t('manage.conflict')}</p>}
      <button type="button" disabled={busy || review.conflict || review.phase !== 'preview'} onClick={confirm}>
        {t(review.scope === 'memories' ? 'manage.confirmMemories' : 'manage.confirmImport')}
      </button>
    </section>
  );
}
