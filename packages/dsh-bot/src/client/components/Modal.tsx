import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import styles from '../styles/bots.module.css';

export interface ModalProps {
  title: string;
  titleAction?: { onClick: () => void; label: string };
  description?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  t: PropsLocale<'dsh-bot'>['t'];
}

export function Modal({ title, titleAction, description, busy, onClose, children, t }: ModalProps) {
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const initial =
      dialog.current?.querySelector<HTMLElement>(
        'input:not([readonly]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
      ) ??
      dialog.current?.querySelector<HTMLElement>('button:not(:disabled)') ??
      dialog.current;
    initial?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    }
    if (event.key !== 'Tab') return;
    const fields = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ) ?? [],
    ).filter((element) => !element.closest('[hidden]'));
    const first = fields[0];
    const last = fields[fields.length - 1];
    if (!first) {
      event.preventDefault();
      dialog.current?.focus();
      return;
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      event.preventDefault();
      last?.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className={styles.backdrop}>
      <dialog
        ref={dialog}
        open
        className={styles.dialog}
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={`${uid}-title`}
        aria-describedby={description ? `${uid}-description` : undefined}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) onClose();
        }}
        onKeyDown={onKeyDown}
      >
        <header className={styles.dialogHeader}>
          <h2 id={`${uid}-title`}>
            {titleAction ? (
              <button
                type="button"
                className={styles.dialogTitleAction}
                title={titleAction.label}
                disabled={busy}
                onClick={titleAction.onClick}
              >
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
          <button type="button" className={styles.button} disabled={busy} onClick={onClose}>
            {t('actions.close')}
          </button>
        </header>
        {description && (
          <p className={styles.dialogDescription} id={`${uid}-description`}>
            {description}
          </p>
        )}
        {children}
      </dialog>
    </div>
  );
}
