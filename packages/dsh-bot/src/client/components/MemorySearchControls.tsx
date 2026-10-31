import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import styles from '../styles/bots.module.css';
import panel from '../styles/memory.module.css';
interface Props {
  search: string;
  busy: boolean;
  t: PropsLocale<'dsh-bot'>['t'];
  onChange(value: string): void;
  onSearch(): void;
  onRefresh(): void;
}
export function MemorySearchControls({ search, busy, t, onChange, onSearch, onRefresh }: Props) {
  return (
    <form
      className={panel.search}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
    >
      <div className={panel.searchGroup}>
        <label className={styles.field}>
          {t('memory.search')}
          <input type="search" value={search} disabled={busy} onChange={(event) => onChange(event.target.value)} />
        </label>
        <button className={styles.button} type="submit" disabled={busy}>
          {t('memory.searchAction')}
        </button>
      </div>
      <button
        className={`${styles.button} ${panel.refresh}`}
        type="button"
        disabled={busy}
        onClick={() => {
          onRefresh();
        }}
      >
        {t('bots.refresh')}
      </button>
    </form>
  );
}
