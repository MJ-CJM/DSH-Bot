import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { type BotCreateInput, type BotPatch, type BotRecord, botCreateSchema, botPatchSchema } from '../../shared/schema.js';
import styles from '../styles/bots.module.css';
import { AvatarPicker } from './AvatarPicker.js';
import { Modal } from './Modal.js';

export interface BotEditorProps {
  bot?: BotRecord;
  duplicate?: boolean;
  busy?: boolean;
  onSave: (input: BotCreateInput | BotPatch) => void | Promise<void>;
  onCancel: () => void;
  t: PropsLocale<'dsh-bot'>['t'];
}

export function BotEditor({ bot, duplicate = false, busy = false, onSave, onCancel, t }: BotEditorProps) {
  const editing = Boolean(bot && !duplicate);
  const uid = useId();
  const mounted = useRef(true);
  const [id, setId] = useState(duplicate && bot ? `${bot.id.slice(0, 27)}-copy` : bot?.id ?? '');
  const [name, setName] = useState(duplicate && bot ? t('editor.copyName', { name: bot.name }) : bot?.name ?? '');
  const [avatar, setAvatar] = useState(bot?.avatar);
  const [description, setDescription] = useState(bot?.description ?? '');
  const [persona, setPersona] = useState(bot?.persona.prefix ?? '');
  const [template, setTemplate] = useState<'standard' | 'minimal'>(bot?.template ?? 'standard');
  const [memory, setMemory] = useState(bot?.memory.enabled ?? true);
  const [injectLimit, setInjectLimit] = useState(String(bot?.memory.injectLimit ?? 20));
  const [deny, setDeny] = useState(bot?.tools.deny.join('\n') ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState(false);
  const [saving, setSaving] = useState(false);
  const disabled = busy || saving;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setFailure(false);
    const fields: BotPatch = {
      name, avatar: avatar ?? null, description,
      // Patches replace a whole top-level field, so retain advanced persona flags.
      persona: { ...bot?.persona, prefix: persona }, template,
      memory: { enabled: memory, injectLimit: injectLimit.trim() === '' ? Number.NaN : Number(injectLimit) },
      tools: { deny: [...new Set(deny.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean))] },
    };
    const input = editing ? fields : {
      ...fields, id, avatar,
      ...(bot ? {
        model: bot.model, skills: bot.skills, defaultCwd: bot.defaultCwd,
        mcpServers: bot.mcpServers, channels: bot.channels, order: bot.order,
      } : {}),
    };
    const result = editing ? botPatchSchema.safeParse(input) : botCreateSchema.safeParse(input);
    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        next[field] = field === 'id' ? t('validation.id') : field === 'name' ? t('validation.name')
          : field === 'persona' ? t('validation.persona') : field === 'memory' ? t('validation.memory')
          : field === 'avatar' ? t('validation.avatar') : t('validation.form');
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSaving(true);
    try { await onSave(result.data); }
    catch { if (mounted.current) setFailure(true); }
    finally { if (mounted.current) setSaving(false); }
  }

  const title = editing ? t('editor.edit') : duplicate ? t('editor.duplicate') : t('editor.create');
  return (
    <Modal title={title} description={t('bots.newSessionsNotice')} busy={disabled} onClose={onCancel} t={t}>
        <form onSubmit={(event) => { void submit(event); }} noValidate>
          <div className={styles.editorBody}>
            {failure && <p className={styles.error} role="alert">{t('errors.save')}</p>}
            {Object.keys(errors).length > 0 && <div className={styles.error} role="alert">
              {Object.entries(errors).map(([field, message]) => <p key={field} id={`${uid}-${field}-error`}>{message}</p>)}
            </div>}
            <div className={styles.formRow}>
              <label className={styles.field}>{t('editor.name')}
                <input value={name} onChange={(event) => setName(event.target.value)} disabled={disabled}
                  required aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? `${uid}-name-error` : undefined} />
              </label>
              <label className={styles.field}>{t('editor.id')}
                <input value={id} onChange={(event) => setId(event.target.value)} readOnly={editing} disabled={disabled}
                  required aria-invalid={Boolean(errors.id)} aria-describedby={`${uid}-id-hint${errors.id ? ` ${uid}-id-error` : ''}`} />
                <span className={styles.hint} id={`${uid}-id-hint`}>{t(editing ? 'editor.idImmutable' : 'editor.idHint')}</span>
              </label>
            </div>
            <AvatarPicker value={avatar} onChange={setAvatar} disabled={disabled} t={t} />
            <label className={styles.field}>{t('editor.description')}
              <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} disabled={disabled} />
            </label>
            <label className={styles.field}>{t('editor.persona')}
              <textarea rows={6} value={persona} onChange={(event) => setPersona(event.target.value)} disabled={disabled}
                aria-invalid={Boolean(errors.persona)} aria-describedby={errors.persona ? `${uid}-persona-error` : undefined} />
            </label>
            <label className={styles.field}>{t('editor.template')}
              <select value={template} onChange={(event) => setTemplate(event.target.value as 'standard' | 'minimal')} disabled={disabled}>
                <option value="standard">{t('editor.templateStandard')}</option>
                <option value="minimal">{t('editor.templateMinimal')}</option>
              </select>
            </label>
            <div className={styles.formRow}>
              <label className={styles.checkboxField}>
                <input type="checkbox" checked={memory} onChange={(event) => setMemory(event.target.checked)} disabled={disabled} />
                {t('editor.memory')}
              </label>
              <label className={styles.field}>{t('editor.injectLimit')}
                <input type="number" min={0} step={1} value={injectLimit} disabled={disabled}
                  onChange={(event) => setInjectLimit(event.target.value)} aria-invalid={Boolean(errors.memory)}
                  aria-describedby={`${uid}-memory-hint${errors.memory ? ` ${uid}-memory-error` : ''}`} />
                <span className={styles.hint} id={`${uid}-memory-hint`}>{t('editor.injectHint')}</span>
              </label>
            </div>
            <label className={styles.field}>{t('editor.hiddenTools')}
              <textarea rows={3} value={deny} onChange={(event) => setDeny(event.target.value)} disabled={disabled}
                aria-describedby={`${uid}-tools-hint`} />
              <span className={styles.hint} id={`${uid}-tools-hint`}>{t('editor.hiddenToolsHint')}</span>
            </label>
          </div>
          <footer className={styles.dialogFooter}>
            <button type="button" className={styles.button} onClick={onCancel} disabled={disabled}>{t('actions.cancel')}</button>
            <button type="submit" className={styles.primaryButton} disabled={disabled}>{t(disabled ? 'editor.saving' : 'editor.save')}</button>
          </footer>
        </form>
    </Modal>
  );
}
