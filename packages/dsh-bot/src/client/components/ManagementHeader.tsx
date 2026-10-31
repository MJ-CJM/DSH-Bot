import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ReactNode } from 'react';
import type { BotRecord } from '../../shared/schema.js';
import styles from '../styles/management-header.module.css';
import css from '../styles/management-header.module.css?inline';

/** Shared title → Bot selection → actions order for management pages. */
export function ManagementHeader({ title, selector, actions, description, level = 2, t }: {
  title: string;
  selector?: { bots: readonly BotRecord[]; value: string; onChange(id: string): void };
  actions?: ReactNode;
  description?: string;
  level?: 2 | 3;
} & PropsLocale<'dsh-bot'>) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <header className={styles.header} data-management-header="">
      <style>{css}</style>
      <Heading>{title}</Heading>
      {selector && (
        <label className={styles.selector}>
          {t('integrations.bot')}
          <select value={selector.value} onChange={(event) => selector.onChange(event.target.value)}>
            {selector.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} ({bot.id})</option>)}
          </select>
        </label>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
      {description && <p>{description}</p>}
    </header>
  );
}
