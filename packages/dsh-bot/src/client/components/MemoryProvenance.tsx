import type { ManagedMemoryRow } from '../../shared/memory-management.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/bots.module.css';

export function MemoryProvenance({ row, t }: { row: ManagedMemoryRow; t: MemoryPanelProps['t'] }) {
  const { version: v, payload: p } = row, source = v.provenance;
  return <div className={styles.hint} data-memory-provenance="" style={{ overflowWrap: 'anywhere' }}>
    <BotAvatar bot={{ id: source.bot.botId, ...p.botSnapshot }} size={24} />{' '}
    <span>{p.botSnapshot?.name ?? source.bot.botId} {row.deletedBot && t('shared.deletedBot')}</span>{' · '}
    <span>{t(`shared.trust.${v.trust}`)}</span>{' · '}
    <span>{t('shared.recorded')}: <time dateTime={new Date(v.recordedAt).toISOString()}>{new Date(v.recordedAt).toLocaleString()}</time></span>
    <p>{t('shared.valid')}: {p.valid.from === null ? t('shared.unknown') : new Date(p.valid.from).toLocaleString()}
      {' → '}{p.valid.to === null ? t('shared.unbounded') : new Date(p.valid.to).toLocaleString()} ({p.valid.basis})</p>
    {row.supersededBy && <p>{t('shared.replacedBy')}: {row.supersededBy}</p>}
    <details><summary>{t('shared.evidence')}</summary>
      {p.sourceExcerpt && <blockquote>{p.sourceExcerpt}</blockquote>}
      <ul>{v.sourceRefs.map((ref) => <li key={JSON.stringify(ref)}>
        {ref.sessionId ?? ref.parentVersionId ?? ref.entryReceiptId ?? ref.managementOpId}
        {ref.eventSeq !== undefined && ` #${ref.eventSeq}`}
      </li>)}</ul>
    </details>
  </div>;
}
