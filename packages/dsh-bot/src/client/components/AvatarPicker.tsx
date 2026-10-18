import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import styles from '../styles/bots.module.css';

const emojis = ['🤖', '🧠', '📝', '💻', '🔬', '📚', '🎨', '🌱', '🚀', '🦊', '🐱', '🌟'];

export interface AvatarPickerProps {
  value?: string;
  disabled?: boolean;
  onChange: (value: string | undefined) => void;
  t: PropsLocale<'dsh-bot'>['t'];
}

export function AvatarPicker({ value, disabled, onChange, t }: AvatarPickerProps) {
  return (
    <fieldset className={styles.avatarPicker} disabled={disabled}>
      <legend>{t('editor.avatar')}</legend>
      <div className={styles.avatarOptions}>
        <span className={styles.avatarPreview}>
          {value?.startsWith('data:')
            ? <img className={styles.avatarImage} src={value} alt={t('avatar.image')} />
            : <span role="img" aria-label={t('avatar.current')}>{value ?? '🤖'}</span>}
        </span>
        {emojis.map((emoji) => (
          <button key={emoji} type="button" className={styles.emojiButton}
            aria-label={t('avatar.choose', { emoji })} aria-pressed={value === emoji}
            onClick={() => onChange(emoji)}>{emoji}</button>
        ))}
        <button type="button" className={styles.button} disabled={!value}
          onClick={() => onChange(undefined)}>{t('avatar.clear')}</button>
      </div>
    </fieldset>
  );
}
