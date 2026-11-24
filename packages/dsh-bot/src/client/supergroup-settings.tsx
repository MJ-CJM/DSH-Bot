import { useEffect, useSyncExternalStore } from 'react';
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import settingsCss from './styles/integrations.module.css?inline';
import styles from './styles/integrations.module.css';

export interface SupergroupSettingsActions {
  settings(): Promise<{ enabled: boolean }>;
  configure(input: { enabled: boolean; expectedEnabled: boolean }): Promise<{ enabled: boolean }>;
}

interface SettingsSnapshot {
  phase: 'idle' | 'reading' | 'ready' | 'saving' | 'readError' | 'saveError';
  enabled?: boolean;
}
const initialSnapshot: SettingsSnapshot = { phase: 'idle' };
const getInitialSnapshot = () => initialSnapshot;
const noSubscription = () => () => {};

/** Both owner surfaces share confirmed values and one in-flight operation per Client. */
export function createSupergroupSettingsSource(actions: SupergroupSettingsActions) {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  function publish(next: SettingsSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  async function request(phase: 'reading' | 'saving', operation: () => Promise<{ enabled: boolean }>) {
    if (snapshot.phase === 'reading' || snapshot.phase === 'saving') return;
    publish({ ...snapshot, phase });
    try {
      const { enabled } = await operation();
      publish({ phase: 'ready', enabled });
    } catch {
      // A lost save response can follow a committed edit. Only a fresh read resolves it.
      publish({ ...snapshot, phase: phase === 'saving' ? 'saveError' : 'readError' });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh: () => request('reading', () => actions.settings()),
    configure(enabled: boolean) {
      const expectedEnabled = snapshot.enabled;
      if (snapshot.phase !== 'ready' || expectedEnabled === undefined || enabled === expectedEnabled) return;
      return request('saving', () => actions.configure({ enabled, expectedEnabled }));
    },
  };
}
export type SupergroupSettingsSource = ReturnType<typeof createSupergroupSettingsSource>;

export function useSupergroupSettings(source?: SupergroupSettingsSource) {
  const snapshot = useSyncExternalStore(source?.subscribe ?? noSubscription, source?.getSnapshot ?? getInitialSnapshot);
  useEffect(() => {
    if (!source) return;
    const refresh = () => { if (document.visibilityState !== 'hidden') void source.refresh(); };
    void source.refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [source]);
  return snapshot;
}

export function supergroupStatusLabel({ phase, enabled }: SettingsSnapshot) {
  switch (phase) {
    case 'idle': case 'reading': return 'supergroup.stateLoading';
    case 'saving': return 'supergroup.stateSaving';
    case 'readError': case 'saveError': return 'supergroup.stateUnknown';
    case 'ready': return enabled ? 'supergroup.stateOn' : 'supergroup.stateOff';
  }
}

type SettingsProps = { source: SupergroupSettingsSource } & PropsLocale<'dsh-bot'>;
export function SupergroupSettingsPanel({ source, snapshot, t }: SettingsProps & { snapshot: SettingsSnapshot }) {
  const { enabled, phase } = snapshot;
  const failed = phase === 'readError' || phase === 'saveError';
  return <section className={styles.panel} data-supergroup-settings="" aria-label={t('supergroup.settingsTitle')}>
    <style>{settingsCss}</style>
    <h3>{t('supergroup.settingsTitle')}</h3>
    <p>{t('supergroup.settingsScope')}</p>
    <div className={styles.switchRow}>
      <span>{t('supergroup.settingsGlobal')}</span>
      <Switch label={t('supergroup.settingsTitle')} checked={enabled ?? false} disabled={phase !== 'ready'}
        onChange={next => { void source.configure(next); }} />
    </div>
    <p role="status">{phase === 'ready' ? t(enabled ? 'supergroup.settingsEnabled' : 'supergroup.settingsDisabled')
      : failed ? t('supergroup.settingsUnknown') : t('supergroup.settingsSaving')}</p>
    <p>{t('supergroup.settingsPermissions')}</p>
    <p>{t('supergroup.settingsReturn')}</p>
    {failed && <><p role="alert">{t(phase === 'saveError' ? 'supergroup.settingsFailed' : 'supergroup.settingsReadFailed')}</p>
      <Button onClick={() => { void source.refresh(); }}>{t('bots.refresh')}</Button></>}
  </section>;
}

export function SupergroupSettings({ source, t }: SettingsProps) {
  const snapshot = useSupergroupSettings(source);
  return <SupergroupSettingsPanel source={source} snapshot={snapshot} t={t} />;
}
