import { useEffect, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { RelayDetails as Detail, RelayDetailsRequest } from '../../shared/group-relay-details.js';
import { unwrapGroup, type GroupActions } from '../groups-state.js';
import styles from '../styles/relay-details.module.css';
import css from '../styles/relay-details.module.css?inline';

/** Mounted only for an open disclosure. A new view or changed membership drops the previous result immediately. */
export function RelayDetails({ actions, request, revision = '', t }: {
  actions: GroupActions; request: RelayDetailsRequest; revision?: string;
} & PropsLocale<'dsh-bot'>) {
  const serialized = JSON.stringify(request), scope = JSON.stringify([serialized, revision]);
  const [loaded, setLoaded] = useState<{ scope: string; detail?: Detail }>();
  useEffect(() => {
    let current = 0, disposed = false, timer: number | undefined;
    const input = JSON.parse(serialized) as RelayDetailsRequest;
    const read = async () => {
      window.clearTimeout(timer);
      const version = ++current;
      if (document.hidden || disposed) { if (!disposed) setLoaded(undefined); return; }
      try {
        const result = unwrapGroup(await actions.remote().getRelayDetails(input));
        if (!disposed && current === version) setLoaded({ scope, detail: result });
      } catch { if (!disposed && current === version) setLoaded({ scope }); }
      finally {
        if (!disposed && current === version) timer = window.setTimeout(read, actions.catalog.getSnapshot().pollIntervalMs);
      }
    };
    const refresh = () => { setLoaded(undefined); void read(); };
    void read();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { disposed = true; current++; window.clearTimeout(timer);
      window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [actions, serialized, scope]);
  const detail = loaded?.scope === scope ? loaded.detail : undefined;
  if (!detail) return <p role="status" data-group-relay-details="">{t(loaded?.scope === scope ? 'groups.relay.unavailable' : 'groups.loading')}</p>;
  return <div data-group-relay-details=""><style>{css}</style><dl className={styles.relayDetails}>
    {(['question', 'answer', 'report'] as const).map(key => {
      const part = detail[key];
      if (!part) return null;
      return <div key={key} data-relay-part={key} data-relay-state={part.state}>
        <dt>{t(`groups.relay.detail.${key}`, { sender: detail.sender, guest: detail.guest })}</dt>
        <dd>{part.state === 'readable' ? part.text : t(`groups.relay.${part.state}`)}</dd>
      </div>;
    })}
  </dl></div>;
}
