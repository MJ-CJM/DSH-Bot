import type { RootInstructions } from '../../shared/memory-forget.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import styles from '../styles/bots.module.css';

export function RootInstructionsWarning({ roots, t }: { roots?: RootInstructions; t: MemoryPanelProps['t'] }) {
  const found = roots?.files.filter(f => f.state !== 'absent');
  if (!found?.length) return null;
  return <aside className={styles.notice} aria-label={t('forget.rootTitle')}>
    <strong>{t('forget.rootTitle')}</strong><p>{t('forget.rootWarning')}</p>
    {found.map(file => <p key={file.path}>{file.path} — {t(file.state === 'present' ? 'forget.present' : 'forget.unknown')}</p>)}
  </aside>;
}
