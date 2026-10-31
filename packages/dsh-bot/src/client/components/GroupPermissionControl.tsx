import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, IconChevronDownOutlineRegular, Menu, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { requiresPermissionAcknowledgement, type GroupPermissionState } from '../group-permission-state.js';
import styles from '../styles/groups.module.css';

export function GroupPermissionControl({ state, disabled = false, t }: {
  state: GroupPermissionState; disabled?: boolean;
} & PropsLocale<'dsh-bot'>) {
  const snapshot = useSyncExternalStore(state.store.subscribe, state.store.getSnapshot);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ owner: GroupPermissionState; preset: string; version: number; currentValue: string | undefined }>();
  const [acknowledged, setAcknowledged] = useState(false);
  const available = snapshot.currentValue !== undefined && snapshot.catalog !== null;
  const boundary = useRef({ state, disabled, version: snapshot.catalogVersion, currentValue: snapshot.currentValue });
  const close = () => { setConfirmation(undefined); setAcknowledged(false); };
  useEffect(() => {
    const previous = boundary.current;
    if (previous.state === state && previous.disabled === disabled && previous.version === snapshot.catalogVersion
      && previous.currentValue === snapshot.currentValue) return;
    boundary.current = { state, disabled, version: snapshot.catalogVersion, currentValue: snapshot.currentValue };
    setOpen(false); setConfirmation(undefined); setAcknowledged(false);
  }, [state, disabled, snapshot.catalogVersion, snapshot.currentValue]);
  const label = (value: string, name = value): string => {
    if (value === 'auto') return t('groups.permissionAuto');
    const key = value === 'read-only' ? 'groups.permissionReadOnly' : value === 'workspace-write'
      ? 'groups.permissionWorkspaceWrite' : value === 'danger-full-access' ? 'groups.permissionFull' : undefined;
    return key && (name === value || name === 'Read Only' || name === 'Workspace Write' || name === 'Full access') ? t(key) : name;
  };
  const submit = (preset: string, consent = false) => { setOpen(false); close(); void state.select(preset, consent); };
  const choose = (preset: string) => {
    setOpen(false);
    if (disabled || !available || snapshot.saving || preset === snapshot.currentValue) return;
    if (requiresPermissionAcknowledgement(preset)) {
      setAcknowledged(false); setConfirmation({ owner: state, preset, version: snapshot.catalogVersion, currentValue: snapshot.currentValue });
    } else submit(preset);
  };
  // Absent projection means this session has no native permission capability.
  if (snapshot.currentValue === undefined && !snapshot.loadError) return null;
  const current = snapshot.catalog?.options.find(option => option.value === snapshot.currentValue);
  const currentLabel = snapshot.currentValue === undefined ? t('groups.permissionUnavailable') : label(snapshot.currentValue, current?.name);
  const validConfirmation = confirmation?.owner === state && confirmation.version === snapshot.catalogVersion && confirmation.currentValue === snapshot.currentValue && available
    && snapshot.catalog?.options.some(option => option.value === confirmation.preset);
  const auto = confirmation?.preset === 'auto';
  return <span className={styles.modelControl}>
    <Menu open={open && available} portal side="top" selectedId={snapshot.currentValue} className={styles.modelMenuAnchor}
      items={snapshot.catalog?.options.map(option => ({ id: option.value, label: label(option.value, option.name) })) ?? []}
      onSelect={choose} onClose={() => setOpen(false)} anchor={<Button variant="ghost" size="sm" className={styles.modelTrigger}
        aria-label={`${t('groups.permission')}: ${currentLabel}`} aria-haspopup="menu" aria-expanded={open && available}
        title={t('groups.permissionScope')} disabled={disabled || snapshot.saving || Boolean(validConfirmation) || !available}
        onClick={() => setOpen(!open)}><span className={styles.modelTriggerLabel}>{currentLabel}</span><IconChevronDownOutlineRegular size={12} /></Button>} />
    {snapshot.loadError && <span role="alert" className={styles.modelError}>{t('groups.permissionLoadFailed')}
      <Button variant="ghost" size="sm" disabled={disabled || snapshot.loading} onClick={() => { void state.refresh(); }}>{t('groups.permissionRetry')}</Button></span>}
    {snapshot.saveError && <span role="alert" className={styles.modelError}>{t('groups.permissionSaveFailed')}</span>}
    {validConfirmation && confirmation && <RiskConfirmation open title={t(auto ? 'groups.permissionAutoConfirmTitle' : 'groups.permissionFullConfirmTitle')}
      description={t(auto ? 'groups.permissionAutoConfirmDescription' : 'groups.permissionFullConfirmDescription')}
      acknowledgeLabel={t('groups.permissionAcknowledge')} cancelLabel={t('groups.permissionCancel')} closeLabel={t('groups.permissionClose')}
      confirmLabel={t(auto ? 'groups.permissionAutoEnable' : 'groups.permissionFullEnable')} acknowledged={acknowledged}
      disabled={disabled || snapshot.saving} onAcknowledgedChange={setAcknowledged} onCancel={close}
      onConfirm={() => { if (!disabled && acknowledged && validConfirmation) submit(confirmation.preset, true); }} />}
  </span>;
}
