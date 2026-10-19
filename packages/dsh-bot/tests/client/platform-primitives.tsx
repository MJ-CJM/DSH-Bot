import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

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
export const IconEllipsisOutlineRegular = Icon;
export const IconMoreHorizontalOutlineRegular = Icon;

export function Menu({ open, anchor, items = [], onSelect, children, className }: {
  open: boolean; anchor: ReactNode; className?: string; children?: ReactNode;
  items?: readonly ({ id: string; label?: ReactNode; disabled?: boolean; type?: string })[];
  onSelect?: (id: string) => void;
}) {
  return <span className={className}>{anchor}{open && <div role="menu">{items.map((item) => item.type
    ? <hr key={item.id} />
    : <button type="button" role="menuitem" key={item.id} disabled={item.disabled} onClick={() => onSelect?.(item.id)}>{item.label}</button>)}{children}</div>}</span>;
}
