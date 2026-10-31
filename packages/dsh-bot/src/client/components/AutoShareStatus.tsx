import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { autoShareStatusSchema } from '../../shared/data-flow.js';
import type { SharedMemoryBinding } from './SharedMemoryPanel.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import styles from '../styles/bots.module.css';
export function AutoShareStatus({ binding, t }: { binding: SharedMemoryBinding; t: MemoryPanelProps['t'] }) {
  const [status, setStatus] = useState<z.output<typeof autoShareStatusSchema>>(), [busy, setBusy] = useState(false);
  const lifetime = useRef(0), active = useRef(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const life = ++lifetime.current; active.current = false; setBusy(false); setError(false);
    void binding.remote().autoShareStatus().then(result => {
      if (lifetime.current !== life) return;
      if (result.ok) setStatus(old => !old || result.value.revision >= old.revision ? result.value : old);
      else setError(true);
    }).catch(() => { if (lifetime.current === life) setError(true); });
    return () => { lifetime.current++; };
  }, [binding]);
  return <aside className={styles.notice} aria-label={t('autoShare.title')}>
    <p>{t('autoShare.unavailable')}</p>
    <p>{t('autoShare.egressBlocked')}</p>
    <p>{t('shadow.offline')}</p>
    {status?.shadow && <p>{t('shadow.status', {
      shadow: t(status.shadow.shadowEnabled ? 'shadow.reportOnly' : 'shadow.off'),
      organize: t(status.shadow.offlineOrganizeEnabled ? 'shadow.reportOnly' : 'shadow.off'),
      opportunities: status.shadow.opportunities, candidates: status.shadow.candidates,
    })}</p>}
    {status && <>
      {status.domainUsed !== undefined && <p>{t('autoShare.usage', { used: status.domainUsed })}</p>}
      <p>{t('autoShare.quotas', { bot: status.botDaily, domain: status.domainDaily, timeZone: status.timeZone })}</p>
      <button type="button" className={styles.button} disabled={busy} onClick={() => {
        if (active.current) return;
        active.current = true; const life = lifetime.current; setBusy(true); setError(false);
        void binding.remote().setAutoShare({ enabled: !status.configured, expectedRevision: status.revision }).then(result => {
          if (!result.ok) throw result.error; if (life === lifetime.current) setStatus(result.value);
        }).catch(() => { if (life === lifetime.current) setError(true); }).finally(() => {
          if (life === lifetime.current) { active.current = false; setBusy(false); }
        });
      }}>{t(status.configured ? 'autoShare.disable' : 'autoShare.enable')}</button>
    </>}
    {error && <p role="alert">{t('shared.changed')}</p>}
  </aside>;
}
