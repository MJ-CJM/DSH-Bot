import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { Button, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BotModeActions } from './index.js';
import { BotBrandGlyph } from '../components/BotBrandGlyph.js';
import css from './mode-switcher.module.css?inline';
import styles from './mode-switcher.module.css';

export interface ModeSwitcherProps extends PropsLocale<'dsh-bot'> {
  /** Use registerBotMode's owner actions, including its readiness/rollback path. */
  actions: BotModeActions;
  className?: string;
  onOpenChats?(): void;
  onOpenSettings?(): void;
  unreadCount?: number;
  compact?: boolean;
}

/** The shared owner setting controls both the shell and Supergroup. Never
 * infer a successful save from the requested value or repeat an uncertain RPC. */
export function ModeSwitcher({ actions, t, className, onOpenChats, onOpenSettings, unreadCount = 0, compact = false }: ModeSwitcherProps) {
  const mode = useSyncExternalStore(actions.status.subscribe, actions.status.getSnapshot);
  const [value, setValue] = useState<{ enabled: boolean }>();
  const [busy, setBusy] = useState(true), [failed, setFailed] = useState(false), [open, setOpen] = useState(false);
  const alive = useRef(false), lock = useRef(false), generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!alive.current || lock.current) return;
    const epoch = generation.current;
    lock.current = true; setBusy(true); setFailed(false);
    try {
      const next = await actions.settings();
      if (alive.current && generation.current === epoch) setValue(next);
    } catch {
      if (alive.current && generation.current === epoch) setFailed(true);
    } finally {
      if (alive.current && generation.current === epoch) { lock.current = false; setBusy(false); }
    }
  }, [actions]);
  useEffect(() => {
    alive.current = true; generation.current++; lock.current = false;
    setValue(undefined); setOpen(false); void refresh();
    return () => { alive.current = false; generation.current++; };
  }, [refresh]);
  // Cross-window changes are already observed by registerBotMode. Re-read the
  // owner after its settled transition; no switch-specific timer or watch.
  useEffect(() => { if (mode.state !== 'starting') void refresh(); }, [mode.state, refresh]);

  const select = (id: string) => {
    if (id === 'refresh') { void refresh(); return; }
    if (id === 'chats' && onOpenChats) { setOpen(false); onOpenChats(); return; }
    if (id === 'settings' && onOpenSettings) { setOpen(false); onOpenSettings(); return; }
    if (id !== 'bot' && id !== 'standard') return;
    if (lock.current || !value || failed || mode.state === 'starting') return;
    const enabled = id === 'bot';
    if (enabled === value.enabled) { setOpen(false); return; }
    const epoch = generation.current;
    lock.current = true; setBusy(true); setFailed(false);
    void actions.configure({ enabled, expectedEnabled: value.enabled }).then(next => {
      if (alive.current && generation.current === epoch) { setValue(next); setOpen(false); }
    }, () => {
      // A committed edit can lose its response. Block both choices until an
      // explicit authoritative read; a second click never replays the write.
      if (alive.current && generation.current === epoch) { setFailed(true); setOpen(true); }
    }).finally(() => {
      if (alive.current && generation.current === epoch) { lock.current = false; setBusy(false); }
    });
  };
  const confirmed = value && !failed;
  const label = !confirmed ? t(busy ? 'botMode.modeReading' : 'botMode.modeUnknown')
    : !value.enabled ? t('botMode.standardMode')
      : mode.state === 'failed' ? t('botMode.modeUnavailable')
        : mode.state !== 'ready' ? t('botMode.modeStarting') : t('botMode.botMode');
  const disabled = busy || !confirmed || mode.state === 'starting';
  return <span className={styles.root} data-bot-mode-switch="" data-mode-state={mode.state} data-mode-known={confirmed ? '' : undefined}>
    <style>{css}</style>
    <Menu open={open} onClose={() => setOpen(false)} portal align="start" side="top" autoFocus className={[styles.menu, className].filter(Boolean).join(' ')}
      selectedId={confirmed ? value.enabled ? 'bot' : 'standard' : undefined}
      anchor={<Button variant="ghost" size="sm" data-bot-mode-switch-button="" aria-haspopup="menu" aria-expanded={open}
        aria-label={`${t('botMode.switchMode', { mode: label })}${unreadCount > 0 ? ` · ${t('activity.unreadCount', { count: unreadCount })}` : ''}`} aria-busy={busy} title={t('botMode.switchMode', { mode: label })}
        style={{ maxWidth: '100%', minWidth: 0, whiteSpace: 'nowrap', position: 'relative',
          ...(compact ? { width: 32, height: 32, padding: 0 } : {}) }} onClick={() => {
          setOpen(!open);
          if (!open) void refresh();
        }}>{compact ? <BotBrandGlyph size={18} /> : <><span className={styles.label}>{label}</span><IconChevronDownOutlineRegular size={14} /></>}
        {unreadCount > 0 && <span data-bot-unread="footer" data-unread="true" role="status" aria-label={t('activity.unreadCount', { count: unreadCount })}
          style={compact ? { position: 'absolute', insetBlockStart: 3, insetInlineEnd: 3, width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-business-primary)' }
            : { minWidth: 14, fontSize: 11, color: 'var(--dsw-alias-state-business-primary)' }}>{compact ? null : unreadCount}</span>}
      </Button>}
      items={[
        { id: 'bot', label: t('botMode.botMode'), disabled },
        { id: 'standard', label: t('botMode.standardMode'), disabled },
        ...(onOpenSettings ? [{ id: 'settings', label: t('botMode.modeSettings') }] : []),
        ...(onOpenChats ? [{ id: 'chats-separator', type: 'separator' as const }, { id: 'chats', label: t('sidebar.sessions') }] : []),
      ]}
      footer={failed ? [{ id: 'refresh', label: t('bots.refresh'), disabled: busy }] : []} onSelect={select}>
      <p style={{ maxWidth: 280, margin: 8, whiteSpace: 'normal', color: 'var(--dsw-alias-label-secondary)' }}>{t('botMode.switchScope')}</p>
      {(failed || mode.state === 'failed') && <p role="alert" style={{ maxWidth: 280, margin: 8, whiteSpace: 'normal', color: 'var(--dsw-alias-label-primary)' }}>
        {t(failed ? 'supergroup.settingsFailed' : 'botMode.notReady')}
      </p>}
      {busy && <span role="status" style={{ display: 'block', margin: 8 }}>{t('supergroup.settingsSaving')}</span>}
    </Menu>
  </span>;
}
