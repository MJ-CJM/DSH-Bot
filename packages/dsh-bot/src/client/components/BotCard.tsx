import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useId, useState } from 'react';
import type { BotStatus } from '../../shared/remote-contract.js';
import type { BotRecord } from '../../shared/schema.js';
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
      <div className={styles.cardHeading}>
        <span className={styles.avatar}>
          {bot.avatar?.startsWith('data:')
            ? <img className={styles.avatarImage} src={bot.avatar} alt={t('avatar.image')} />
            : <span aria-hidden="true">{bot.avatar ?? '🤖'}</span>}
        </span>
        <div className={styles.cardIdentity}>
          <h2 id={`${id}-title`} className={styles.cardTitle}>{bot.name}</h2>
          <span className={styles.botId}>{bot.id}</span>
        </div>
      </div>
      <p className={styles.description}>{bot.description || t('card.noDescription')}</p>
      {status?.warnings?.includes('avatar/invalid') && <p className={styles.warning}>{t('avatar.invalidStored')}</p>}
      {!ready && <p className={styles.warning} id={`${id}-status`}>
        {unavailable}{status?.preset.reason ? ` ${status.preset.reason}` : ''}
      </p>}
      <div className={styles.cardActions}>
        <button type="button" className={styles.primaryButton} disabled={busy || !ready}
          aria-describedby={!ready ? `${id}-status` : undefined} onClick={onStart}>{t('card.start')}</button>
        <button type="button" className={styles.button} disabled={busy} onClick={onEdit}>{t('card.edit')}</button>
        <div className={styles.moreContainer}>
          <button type="button" className={styles.button} disabled={busy} aria-expanded={more}
            aria-controls={`${id}-more`} onClick={() => setMore(!more)}>{t('card.more')}</button>
          {more && <div className={styles.moreActions} id={`${id}-more`}>
            <button type="button" className={styles.button} disabled={busy}
              onClick={() => { setMore(false); onDuplicate(); }}>{t('card.duplicate')}</button>
            <button type="button" className={styles.dangerButton} disabled={busy}
              onClick={() => { setMore(false); onDelete(); }}>{t('actions.delete')}</button>
          </div>}
        </div>
      </div>
    </article>
  );
}
