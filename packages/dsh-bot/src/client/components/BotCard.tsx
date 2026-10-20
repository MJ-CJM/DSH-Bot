import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { Button, IconEllipsisOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { useId, useState } from 'react';
import type { BotStatus } from '../../shared/remote-contract.js';
import type { BotRecord } from '../../shared/schema.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/bots.module.css';

export interface BotCardProps {
  bot: BotRecord;
  status?: BotStatus;
  busy?: boolean;
  onStart: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  t: PropsLocale<'dsh-bot'>['t'];
}

export function BotCard({ bot, status, busy, onStart, onEdit, onDuplicate, onDelete, t }: BotCardProps) {
  const [more, setMore] = useState(false);
  const id = useId();
  const ready = status?.preset.state === 'ok';
  const unavailable = !status ? t('card.statusUnknown')
    : status.preset.state === 'broken' ? t('card.statusBroken') : t('card.statusMissing');
  return (
    <article className={styles.card} aria-labelledby={`${id}-title`}>
      <header className={styles.cardHeading}>
        <BotAvatar bot={bot} size={48} />
        <div className={styles.cardIdentity}>
          <h2 id={`${id}-title`} className={styles.cardTitle} title={bot.name}>{bot.name}</h2>
          <span className={styles.botId}>{bot.id}</span>
        </div>
        <Menu open={more} onClose={() => setMore(false)} align="end" className={styles.moreContainer}
          anchor={<Button variant="ghost" size="sm" className={styles.iconButton} disabled={busy}
            aria-label={t('card.more')} title={t('card.more')} aria-haspopup="menu" aria-expanded={more}
            onClick={() => setMore(!more)}><IconEllipsisOutlineRegular size={18} /></Button>}
          items={[
            { id: 'duplicate', label: t('card.duplicate'), disabled: busy },
            { id: 'delete', label: t('actions.delete'), disabled: busy, danger: true },
          ]}
          onSelect={(action) => { setMore(false); if (action === 'duplicate') onDuplicate(); else if (action === 'delete') onDelete(); }} />
      </header>
      <p className={styles.description}>{bot.description || t('card.noDescription')}</p>
      {status?.warnings?.includes('avatar/invalid') && <p className={styles.statusNotice}>{t('avatar.invalidStored')}</p>}
      {!ready && <p className={styles.statusNotice} id={`${id}-status`} role="status">
        {unavailable}{status?.preset.reason ? ` ${status.preset.reason}` : ''}
      </p>}
      <footer className={styles.cardActions}>
        <Button variant="primary" size="sm" disabled={busy || !ready}
          aria-describedby={!ready ? `${id}-status` : undefined} onClick={onStart}>{t('card.start')}</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onEdit}>{t('card.edit')}</Button>
      </footer>
    </article>
  );
}
