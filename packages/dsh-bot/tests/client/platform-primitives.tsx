import { useEffect, useRef, forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string; size?: string; icon?: ReactNode;
}>(function Button({ variant, size, icon, children, ...props }, ref) {
  return <button type="button" {...props} ref={ref} data-platform-variant={variant} data-platform-size={size}>{icon}{children}</button>;
});

export function FishLogo({ size = 24, className }: { size?: number; className?: string }) {
  return <svg data-platform-fish="" aria-hidden="true" width={size} height={size} className={className} />;
}

function Icon({ size = 16, className }: { size?: number; className?: string }) {
  return <svg aria-hidden="true" width={size} height={size} className={className} />;
}
export const IconPlusOutlineRegular = Icon;
export const IconRefreshOutlineRegular = Icon;
export const IconSearchOutlineRegular = Icon;
export const IconCloseOutlineRegular = Icon;
export const IconEllipsisOutlineRegular = Icon;
export const IconMoreHorizontalOutlineRegular = Icon;
export const IconDataOutlineRegular = Icon;
export const IconChevronDownOutlineRegular = Icon;
export const IconPaperclipOutlineRegular = Icon;
export const IconSendOutlineRegular = Icon;
export const IconThinkOutlineRegular = Icon;
export const IconRightUpOutlineRegular = Icon;
export const IconSettingsOutlineRegular = Icon;
export const IconShieldOutlineRegular = Icon;
export const IconDownloadOutlineRegular = Icon;
export const IconPaperPlaneOutlineRegular = Icon;
export const IconGaugeOutlineRegular = Icon;
export const IconDatabaseOutlineRegular = Icon;
export function StateDot({ state, className }: { state: string; size?: number; className?: string }) {
  return <span aria-hidden="true" data-state-dot={state} className={className} />;
}

export function rankByName<T extends { name: string; label?: string }>(items: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  const matches = (value: string) => [...needle].every(char => value.toLocaleLowerCase().includes(char));
  return items.filter(item => matches(item.name) || (item.label && matches(item.label)));
}

export function DisclosureRow({ title, open, onToggle, collapsedContent, children, running }: {
  title: string; open: boolean; onToggle(): void; collapsedContent?: ReactNode; children?: ReactNode; running?: boolean;
}) {
  return <div data-disclosure-row="" data-running={running}><button type="button" aria-expanded={open} onClick={onToggle}>{title}</button>
    {!open && collapsedContent}{open && children}</div>;
}

/** Provider double: verifies MarkdownText props/ownership, not the native parser's HTML output. */
export function MarkdownText({ text }: { text: string; labels: unknown; variant?: string }) {
  return <div data-platform-markdown="">{text}</div>;
}

type MenuEntryDouble = { id: string; label?: ReactNode; icon?: ReactNode; disabled?: boolean; type?: string; text?: string };
export function Menu({ open, anchor, items = [], footer = [], selectedId, onSelect, children, className }: {
  open: boolean; anchor: ReactNode; className?: string; children?: ReactNode;
  items?: readonly MenuEntryDouble[]; footer?: readonly MenuEntryDouble[];
  selectedId?: string | undefined; portal?: boolean; side?: string; listClassName?: string;
  onSelect?: (id: string) => void;
}) {
  // Mirrors the public entry contract: separators and non-interactive labels are presentation rows;
  // the selected row is marked (the native list draws a trailing check).
  const entry = (item: MenuEntryDouble) => item.type === 'separator' ? <hr key={item.id} />
    : item.type === 'label' ? <div key={item.id} role="presentation" data-menu-label="">{item.text}</div>
    : <button type="button" role="menuitem" key={item.id} disabled={item.disabled} data-menu-selected={item.id === selectedId ? '' : undefined} onClick={() => onSelect?.(item.id)}>{item.icon}{item.label}</button>;
  return <span className={className}>{anchor}{open && <div role="menu">{items.map(entry)}{children}
    {footer.length > 0 && <div role="presentation" data-menu-footer="">{footer.map(entry)}</div>}</div>}</span>;
}
export function PathLabel({ path, ...attributes }: { path: string } & import('react').HTMLAttributes<HTMLSpanElement>) {
  return <span {...attributes} title={path} data-path-label="">{path}</span>;
}

export function MenuSurface({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) { return <div {...props}>{children}</div>; }
export function observeComposition(document: Document) {
  let composing = false, ended = false;
  const start = () => { composing = true; }, end = () => { composing = false; ended = true; }, release = () => { ended = false; };
  document.addEventListener('compositionstart', start); document.addEventListener('compositionend', end); document.addEventListener('keyup', release);
  return { guards(event: KeyboardEvent) { const guarded = composing || ended || event.isComposing || event.keyCode === 229; ended = false; return guarded; }, dispose() { document.removeEventListener('compositionstart', start); document.removeEventListener('compositionend', end); document.removeEventListener('keyup', release); } };
}

/** Contract doubles only; native portal/keyboard behavior is covered by native-settings-spike.mjs. */
export const Input = forwardRef<HTMLInputElement, import('react').InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(function Input({ icon, className, ...props }, ref) {
  return <span className={className}>{icon && <span>{icon}</span>}<input {...props} ref={ref} /></span>;
});
export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange(value: boolean): void; label: string; disabled?: boolean }) {
  return <label><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />{label}</label>;
}
export function SegmentedTabs({ items, value, onChange, label }: { items: readonly { value: string; label: ReactNode; id: string; panelId: string }[]; value: string; onChange(value: string): void; label: string }) {
  return <div role="tablist" aria-label={label}>{items.map(item => <button type="button" role="tab" key={item.value} id={item.id} aria-controls={item.panelId} aria-selected={item.value === value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}
export function Modal({ open, title, onClose, children, className }: { open: boolean; title: string; onClose(): void; children?: ReactNode; className?: string; headless?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    (dialog.current?.querySelector<HTMLElement>('[data-modal-autofocus], input:not(:disabled), textarea:not(:disabled), button:not(:disabled)') ?? dialog.current)?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  return open ? <dialog open ref={dialog} className={className} aria-modal="true" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const fields = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])].filter(el => !el.closest('[hidden]'));
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus(); }
    }
  }}>{children}</dialog> : null;
}

export function Toast({ text, onDone }: { text: string; onDone(): void }) { return <div role="status">{text}<button type="button" onClick={onDone}>Dismiss</button></div>; }

export function JsonBlock({ label, payload }: { label: string; payload: unknown }) { return <details><summary>{label}</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>; }

export function ImageLightbox({ src, alt, labels, onClose }: { src: string; alt: string; labels: { dialog: string; close: string }; onClose(): void }) {
  return <div role="dialog" aria-label={labels.dialog}><img src={src} alt={alt} /><button type="button" onClick={onClose}>{labels.close}</button></div>;
}
