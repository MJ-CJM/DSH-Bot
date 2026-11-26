import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { Modal as NativeModal, Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ReactNode } from 'react';
import { useStyleSheet } from '../use-style-sheet.js';
import styles from '../styles/bots.module.css';
import css from '../styles/bots.module.css?inline';

export interface ModalProps {
  title: string;
  titleAction?: { onClick: () => void; label: string };
  description?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  closeLabel?: string;
  t?: PropsLocale<'dsh-bot'>['t'];
}

/** Native layer owns portal, inert background, Escape and focus restoration. */
export function Modal({ title, titleAction, description, busy, onClose, children, closeLabel, t }: ModalProps) {
  useStyleSheet('bots', css);
  return <NativeModal open headless title={title} className={styles.dialog} onClose={() => { if (!busy) onClose(); }}>
    <header className={styles.dialogHeader}>
      <h2>{title}</h2>
      <div className={styles.dialogHeaderActions}>
        {titleAction && (
          <Button variant="ghost" size="sm" disabled={busy} title={titleAction.label} onClick={titleAction.onClick}>
            {titleAction.label}
          </Button>
        )}
        <Button disabled={busy} onClick={onClose}>{closeLabel ?? t?.('actions.close') ?? 'Close'}</Button>
      </div>
    </header>
    {description && <p className={styles.dialogDescription}>{description}</p>}
    {children}
  </NativeModal>;
}
