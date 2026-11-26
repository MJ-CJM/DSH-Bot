import type { ManagedMemoryRow } from '../../shared/memory-management.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import { formatDateTime } from '../format.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/bots.module.css';

export function MemoryProvenance({ row, t }: { row: ManagedMemoryRow; t: MemoryPanelProps['t'] }) {
  const { version: v, payload: p } = row, source = v.provenance;
  return <div className={styles.hint} data-memory-provenance="" style={{ overflowWrap: 'anywhere' }}>
    <BotAvatar bot={{ id: source.bot.botId, ...p.botSnapshot }} size={24} />{' '}
    <span>{p.botSnapshot?.name ?? source.bot.botId} {row.deletedBot && t('shared.deletedBot')}</span>{' · '}
    <span>{t(`shared.trust.${v.trust}`)}</span>{' · '}
    <span>{t('shared.recorded')}: <time dateTime={new Date(v.recordedAt).toISOString()}>{formatDateTime(v.recordedAt, t('activity.locale'))}</time></span>
    <p>{t('shared.valid')}: {p.valid.from === null ? t('shared.unknown') : formatDateTime(p.valid.from, t('activity.locale'))}
      {' → '}{p.valid.to === null ? t('shared.unbounded') : formatDateTime(p.valid.to, t('activity.locale'))} ({p.valid.basis})</p>
    <p>{t('shared.contextScope')}: {v.labels.readers === 'shared' ? t('shared.readersAll') : v.labels.readers.map(reader => reader.botId).join(', ')}</p>
    {row.supersededBy && <p>{t('shared.replacedBy')}: {row.supersededBy}</p>}
    <details><summary>{t('shared.evidence')}</summary>
      <p>{t('shared.version')}: <code>{v.versionId}</code></p>
      {p.sourceExcerpt && <blockquote>{p.sourceExcerpt}</blockquote>}
      <ul>{v.sourceRefs.map((ref) => <li key={JSON.stringify(ref)}>
        {ref.sessionId ?? ref.parentVersionId ?? ref.entryReceiptId ?? ref.managementOpId}
        {ref.eventSeq !== undefined && ` #${ref.eventSeq}`}
      </li>)}</ul>
    </details>
  </div>;
}
