import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useContext, type ReactNode } from 'react';
import { SettingsBotContext } from './SettingsBotContext.js';
import type { BotRecord } from '../../shared/schema.js';
import { useStyleSheet } from '../use-style-sheet.js';
import styles from '../styles/management-header.module.css';
import css from '../styles/management-header.module.css?inline';
import { useSettingsLeave } from './SettingsNavigation.js';

/** Shared title → Bot selection → actions order for management pages. */
export function ManagementHeader({ title, selector, actions, description, level = 2, contextSelector = false, t }: {
  title: string;
  contextSelector?: boolean;
  selector?: { bots: readonly BotRecord[]; value: string; onChange(id: string): void };
  actions?: ReactNode;
  description?: string;
  level?: 2 | 3;
} & PropsLocale<'dsh-bot'>) {
  useStyleSheet('management-header', css);
  const Heading = level === 2 ? 'h2' : 'h3';
  const shared = useContext(SettingsBotContext);
  const leave = useSettingsLeave();
  return (
    <header className={styles.header} data-management-header="">
      {!contextSelector && <Heading>{title}</Heading>}
      {selector && (!shared || contextSelector) && (
        <label className={styles.selector}>
          {t('integrations.bot')}
          <select aria-label={t('integrations.bot')} value={selector.value} onChange={(event) => { const id = event.target.value; leave(() => selector.onChange(id)); }}>
            <option value="" disabled>{t('settings.chooseBot')}</option>
            {selector.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}{selector.bots.filter(b => b.name === bot.name).length > 1 ? ` (${bot.id})` : ''}</option>)}
          </select>
        </label>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
      {description && <p>{description}</p>}
    </header>
  );
}
