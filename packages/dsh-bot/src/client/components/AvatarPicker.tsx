import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { AVATAR_COLOR_TOKENS, AVATAR_VARIANTS, AVATAR_MAX_BYTES, avatarSchema, type AvatarColor, type AvatarVariant } from '../../shared/schema.js';
import styles from '../styles/bots.module.css';
import picker from '../styles/avatar.module.css';
import css from '../styles/avatar.module.css?inline';
import { avatarColors, BotAvatar, defaultAvatarColor, resolvedAvatarVariant } from './BotAvatar.js';

const emojis = ['🤖', '🧠', '📝', '💻', '🔬', '📚', '🎨', '🌱', '🚀', '🦊', '🐱', '🌟'];

export interface AvatarPickerProps {
  id: string;
  value?: string;
  color?: AvatarColor;
  variant?: AvatarVariant;
  onVariantChange: (value: AvatarVariant) => void;
  disabled?: boolean;
  onChange: (value: string | undefined) => void;
  onColorChange: (value: AvatarColor | undefined) => void;
  t: PropsLocale<'dsh-bot'>['t'];
}

export function AvatarPicker({ id, value, color, variant, disabled, onChange, onColorChange, onVariantChange, t }: AvatarPickerProps) {
  const reader = useRef<FileReader>();
  const [invalid, setInvalid] = useState(false);
  const selectedVariant = resolvedAvatarVariant({ id, avatarVariant: variant });
  const selectedColor = color ?? defaultAvatarColor(id);
  useEffect(() => () => { reader.current?.abort(); }, []);

  function upload(file?: File) {
    reader.current?.abort();
    setInvalid(false);
    if (!file) return;
    if (!/^image\/(?:png|jpeg|gif|webp)$/u.test(file.type) || file.size > AVATAR_MAX_BYTES) {
      setInvalid(true);
      return;
    }
    const next = new FileReader();
    reader.current = next;
    next.onload = () => {
      if (reader.current !== next) return;
      const parsed = avatarSchema.safeParse(next.result);
      if (parsed.success) onChange(parsed.data);
      else setInvalid(true);
    };
    next.onerror = () => { if (reader.current === next) setInvalid(true); };
    next.readAsDataURL(file);
  }

  function moveSelection(event: KeyboardEvent<HTMLFieldSetElement>) {
    if (disabled || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
    buttons[next]?.click();
  }

  function selectColor(next?: AvatarColor) {
    reader.current?.abort();
    onColorChange(next);
    onChange(undefined);
    setInvalid(false);
  }

  return <fieldset className={picker.picker} data-avatar-picker="" disabled={disabled}>
    <style data-dsh-bot-avatar-picker-styles="">{css}</style>
    <legend>{t('editor.avatar')}</legend>
    <div className={picker.previewRow}>
      <BotAvatar bot={{ id, avatar: value, avatarColor: color, avatarVariant: variant }} size={64} label={t('avatar.current')} />
      <button type="button" className={styles.button} aria-pressed={!value && variant === 'auto' && !color}
        onClick={() => { selectColor(); onVariantChange('auto'); }}>{t('avatar.automatic')}</button>
    </div>
    <div className={picker.palette}>
      <fieldset className={picker.swatches} onKeyDown={moveSelection} aria-label={t('avatar.variant')}>
        <legend className={styles.hint}>{t('avatar.variant')}</legend>
        {AVATAR_VARIANTS.map((shape) => <button key={shape} type="button" className={picker.swatch}
          title={t(`avatar.variant.${shape}`)} aria-label={t(`avatar.variant.${shape}`)}
          aria-pressed={!value && selectedVariant === shape} onClick={() => { selectColor(color); onVariantChange(shape); }}>
          <BotAvatar bot={{ id, avatarColor: color, avatarVariant: shape }} size={40} />
        </button>)}
      </fieldset>
      <fieldset className={picker.swatches} onKeyDown={moveSelection} aria-label={t('avatar.color')}>
        <legend className={styles.hint}>{t('avatar.color')}</legend>
        {AVATAR_COLOR_TOKENS.map((token) => <button key={token} type="button" className={picker.swatch}
          title={t(avatarColors[token].label)} aria-label={t(avatarColors[token].label)}
          aria-pressed={!value && selectedColor === token} onClick={() => selectColor(token)}>
          <BotAvatar bot={{ id, avatarColor: token, avatarVariant: selectedVariant }} size={30} />
        </button>)}
      </fieldset>
    </div>
    <details className={picker.other}>
      <summary>{t('avatar.otherOptions')}</summary>
      <div className={picker.emojis}>
        {emojis.map((emoji) => <button key={emoji} type="button" className={styles.emojiButton}
          aria-label={t('avatar.choose', { emoji })} aria-pressed={value === emoji}
          onClick={() => { reader.current?.abort(); setInvalid(false); onChange(emoji); }}>{emoji}</button>)}
      </div>
      <label className={styles.field}>{t('avatar.upload')}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={disabled}
          onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ''; }} />
        <span className={styles.hint}>{t('avatar.uploadHint')}</span>
      </label>
      <button type="button" className={styles.button} disabled={!value} onClick={() => {
        reader.current?.abort(); setInvalid(false); onChange(undefined);
      }}>{t('avatar.clear')}</button>
    </details>
    {invalid && <p className={styles.error} role="alert">{t('validation.avatar')}</p>}
  </fieldset>;
}
