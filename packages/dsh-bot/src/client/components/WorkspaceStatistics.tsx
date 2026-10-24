import { useEffect, useRef, useState, useCallback } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceActions } from '../workspace-state.js';
import type { z } from 'zod';
const unwrap = <T,>(r: RemoteResult<T>): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
type Locale = PropsLocale<'dsh-bot'>;
import styles from '../styles/integrations.module.css';
import type { workspaceSummarySchema } from '../../shared/workspace.js';
export function Statistics({ actions, t }: { actions: WorkspaceActions } & Locale) {
  const [value, setValue] = useState<z.output<typeof workspaceSummarySchema>>(),
    [failed, setFailed] = useState(false);
  const lifetime = useRef(0),
    request = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = lifetime.current,
      latest = ++request.current;
    try {
      const r = unwrap(await actions.workspace({ action: 'summary' }));
      if (epoch !== lifetime.current || latest !== request.current) return;
      if (r.kind === 'summary') setValue(r.summary);
      setFailed(false);
    } catch {
      if (epoch === lifetime.current && latest === request.current) setFailed(true);
    }
  }, [actions]);
  useEffect(() => {
    lifetime.current++;
    void refresh();
    return () => {
      lifetime.current++;
    };
  }, [refresh]);
  return (
    <section className={styles.statistics} aria-label={t('manage.statistics')}>
      <h3>{t('manage.statistics')}</h3>
      <p>{t('manage.sampleHint')}</p>
      <dl className={styles.statGrid}>
        {(['accepted', 'completed', 'failed', 'unknown'] as const).map((key) => (
          <div key={key}>
            <dt>{t(`manage.stat-${key}`)}</dt>
            <dd>{value?.available ? value[key] : t('manage.unknown')}</dd>
          </div>
        ))}
      </dl>
      {failed && <p role="alert">{t('manage.statsFailed')}</p>}
      <button
        type="button"
        onClick={() => {
          void refresh();
        }}
      >
        {t('bots.refresh')}
      </button>
    </section>
  );
}
