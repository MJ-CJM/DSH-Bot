import { useId, useRef } from 'react';
import { Button, IconCloseOutlineRegular, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import styles from '../styles/search-field.module.css';
import css from '../styles/search-field.module.css?inline';

export function SearchField({ label, clearLabel, value, onChange, className }: {
  label: string;
  clearLabel: string;
  value: string;
  onChange(value: string): void;
  className?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const clear = () => {
    onChange('');
    input.current?.focus();
  };
  return <>
    <style>{css}</style>
    <div className={`${styles.search} ${className ?? ''}`}>
      <label className={styles.label} htmlFor={id}>
        <span className={styles.srOnly}>{label}</span>
        <Input id={id} ref={input} className={styles.input} icon={<IconSearchOutlineRegular size={14} />}
          type="search" placeholder={label} value={value} onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Escape' || !value || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            event.stopPropagation();
            clear();
          }} />
      </label>
      {value && <Button variant="ghost" size="sm" className={styles.clear} aria-label={clearLabel} title={clearLabel} onClick={clear}>
        <IconCloseOutlineRegular size={14} />
      </Button>}
    </div>
  </>;
}
