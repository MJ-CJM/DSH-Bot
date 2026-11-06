import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { Modal as NativeModal, Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ReactNode } from 'react';
import styles from '../styles/bots.module.css';
import css from '../styles/bots.module.css?inline';

export interface ModalProps {
  title: string;
  titleAction?: { onClick: () => void; label: string };
  description?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  t: PropsLocale<'dsh-bot'>['t'];
}

/** Native layer owns portal, inert background, Escape and focus restoration. */
export function Modal({ title, titleAction, description, busy, onClose, children, t }: ModalProps) {
  return <NativeModal open headless title={title} className={styles.dialog} onClose={() => { if (!busy) onClose(); }}>
    <style>{css}</style>
    <header className={styles.dialogHeader}>
      <h2>{titleAction ? <Button variant="ghost" disabled={busy} title={titleAction.label} aria-label={titleAction.label} onClick={titleAction.onClick}>{title}</Button> : title}</h2>
      <Button disabled={busy} onClick={onClose}>{t('actions.close')}</Button>
    </header>
    {description && <p className={styles.dialogDescription}>{description}</p>}
    {children}
  </NativeModal>;
}
