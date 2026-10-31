import type { ModelActions, ModelCatalogData } from '../model-catalog-state.js';
import type { CapabilityKey } from './CapabilitiesPanel.js';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  type BotCreateInput,
  type BotPatch,
  type BotRecord,
  botCreateSchema,
  botPatchSchema,
} from '../../shared/schema.js';
import styles from '../styles/bots.module.css';
import { AvatarPicker } from './AvatarPicker.js';
import { BotAvatar } from './BotAvatar.js';
import { Modal } from './Modal.js';

export interface BotEditorProps {
  bot?: BotRecord;
  models?: ModelActions;
  memoryPanel?: ReactNode;
  avatarWarning?: boolean;
  duplicate?: boolean;
  busy?: boolean;
  creationSaved?: boolean;
  onEnsureHome?: (id: string) => Promise<string>;
  onEnsureBotsWorkspace?: () => Promise<string>;
  onPickDirectory?: () => Promise<string | null>;
  onSave: (input: BotCreateInput | BotPatch) => void | Promise<void>;
  onCancel: () => void;
  t: PropsLocale<'dsh-bot'>['t'];
}

export function BotEditor({
  bot,
  models,
  memoryPanel,
  avatarWarning,
  duplicate = false,
  busy = false,
  creationSaved = false,
  onSave,
  onCancel,
  onEnsureHome,
  onEnsureBotsWorkspace,
  onPickDirectory,
  t,
}: BotEditorProps) {
  const [tab, setTab] = useState<'settings' | 'memory'>('settings');
  const editing = Boolean(bot && !duplicate);
  const uid = useId();
  const mounted = useRef(true);
  const [id] = useState(() => duplicate && bot ? `${bot.id.slice(0, 27)}-copy` : (bot?.id ?? `bot-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`));
  const [avatarOpen, setAvatarOpen] = useState(false);
  const text = (key: string) => t(key as Parameters<typeof t>[0]);
  const [name, setName] = useState(duplicate && bot ? t('editor.copyName', { name: bot.name }) : (bot?.name ?? ''));
  const [avatar, setAvatar] = useState(bot?.avatar);
  const [avatarColor, setAvatarColor] = useState(bot?.avatarColor);
  const [avatarVariant, setAvatarVariant] = useState(bot?.avatarVariant ?? (bot ? 'classic' : 'auto'));
  const [defaultCwd, setDefaultCwd] = useState(bot?.defaultCwd ?? '');
  const [home, setHome] = useState<string>();
  const [homeFailed, setHomeFailed] = useState(false);
  const [botsPath, setBotsPath] = useState<string>();
  const [workspaceFailed, setWorkspaceFailed] = useState(false);
  const [homeAttempt, setHomeAttempt] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pickFailed, setPickFailed] = useState(false);
  const [description, setDescription] = useState(bot?.description ?? '');
  const [persona, setPersona] = useState(bot?.persona.prefix ?? '');
  const [modelEnabled, setModelEnabled] = useState(Boolean(bot?.model));
  const [provider, setProvider] = useState(bot?.model?.provider ?? '');
  const [modelId, setModelId] = useState(bot?.model?.model ?? '');
  const [reasoning, setReasoning] = useState(bot?.model?.reasoningEffort ?? '');
  const [modelCatalog, setModelCatalog] = useState<{ providers: ModelCatalogData['providers']; error?: unknown }>();
  const [efforts, setEfforts] = useState<{ id: string; name: string }[]>([]);
  const cap = (key: CapabilityKey) => t(key as Parameters<typeof t>[0]);
  useEffect(() => {
    if (!models) return;
    const update = () => setModelCatalog(models.catalog.getSnapshot());
    update(); return models.catalog.observe(update);
  }, [models]);
  useEffect(() => {
    let active = true; setEfforts([]);
    if (models && provider && modelId) void models.modelInfo(provider, modelId).then(info => {
      if (active) setEfforts(info.reasoning?.efforts ?? []);
    }, () => {});
    return () => { active = false; };
  }, [models, provider, modelId]);
  const [extraDirs, setExtraDirs] = useState(bot?.skills.extraDirs.join('\n') ?? '');
  const [suffix, setSuffix] = useState(bot?.persona.suffix ?? '');
  const [complete, setComplete] = useState(bot?.persona.complete ?? false);
  const [template, setTemplate] = useState<'standard' | 'minimal'>(bot?.template ?? 'standard');
  const [memory, setMemory] = useState(bot?.memory.enabled ?? true);
  const [injectLimit, setInjectLimit] = useState(String(bot?.memory.injectLimit ?? 20));
  const [deny, setDeny] = useState(bot?.tools.deny.join('\n') ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState(false);
  const [saving, setSaving] = useState(false);
  const disabled = busy || saving || picking;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new Bot has no Host record yet; its home is allocated after saving.
  // biome-ignore lint/correctness/useExhaustiveDependencies: homeAttempt explicitly retries the current directory lookups.
  useEffect(() => {
    let current = true;
    setHome(undefined);
    setHomeFailed(false);
    setBotsPath(undefined);
    setWorkspaceFailed(false);
    if (editing && bot && onEnsureHome)
      void onEnsureHome(bot.id).then(
        (path) => {
          if (current) setHome(path);
        },
        () => {
          if (current) setHomeFailed(true);
        },
      );
    if (editing && onEnsureBotsWorkspace)
      void onEnsureBotsWorkspace().then(
        (path) => {
          if (current) setBotsPath(path);
        },
        () => {
          if (current) setWorkspaceFailed(true);
        },
      );
    return () => {
      current = false;
    };
  }, [editing, bot?.id, onEnsureHome, onEnsureBotsWorkspace, homeAttempt]);

  const chooseDirectory = async () => {
    if (!onPickDirectory || disabled) return;
    setPicking(true);
    setPickFailed(false);
    try {
      const path = await onPickDirectory();
      if (mounted.current && path !== null) setDefaultCwd(path);
    } catch {
      if (mounted.current) setPickFailed(true);
    } finally {
      if (mounted.current) setPicking(false);
    }
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setFailure(false);
    const fields: BotPatch = {
      name,
      avatar: avatar ?? null,
      avatarColor: avatarColor ?? null,
      avatarVariant,
      description,
      defaultCwd: defaultCwd.trim() || null,
      // Patches replace a whole top-level field, so retain advanced persona flags.
      persona: {
        prefix: persona,
        ...(suffix || bot?.persona.suffix !== undefined ? { suffix } : {}),
        ...(complete || bot?.persona.complete !== undefined ? { complete } : {}),
      },
      template,
      model: modelEnabled
        ? {
            provider: provider.trim(),
            model: modelId.trim(),
            ...(reasoning.trim() ? { reasoningEffort: reasoning.trim() } : {}),
          }
        : null,
      skills: {
        extraDirs: [
          ...new Set(
            extraDirs
              .split('\n')
              .map((p) => p.trim())
              .filter(Boolean),
          ),
        ],
      },
      memory: { enabled: memory, injectLimit: injectLimit.trim() === '' ? Number.NaN : Number(injectLimit) },
      tools: {
        deny: [
          ...new Set(
            deny
              .split(/[\n,]/u)
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ],
      },
    };
    // Compare the draft representation, not normalized record values: untouched arrays,
    // optional flags and whitespace must survive an unrelated rename exactly.
    if (editing && bot) {
      const changed: Record<string, boolean> = {
        name: name !== bot.name, avatar: avatar !== bot.avatar, avatarColor: avatarColor !== bot.avatarColor,
        avatarVariant: avatarVariant !== (bot.avatarVariant ?? 'classic'),
        description: description !== (bot.description ?? ''), defaultCwd: defaultCwd !== (bot.defaultCwd ?? ''),
        persona: persona !== (bot.persona.prefix ?? '') || suffix !== (bot.persona.suffix ?? '') || complete !== (bot.persona.complete ?? false),
        template: template !== bot.template,
        model: modelEnabled !== Boolean(bot.model) || provider !== (bot.model?.provider ?? '') || modelId !== (bot.model?.model ?? '') || reasoning !== (bot.model?.reasoningEffort ?? ''),
        skills: extraDirs !== bot.skills.extraDirs.join('\n'),
        memory: memory !== bot.memory.enabled || injectLimit !== String(bot.memory.injectLimit),
        tools: deny !== bot.tools.deny.join('\n'),
      };
      for (const key of Object.keys(fields) as Array<keyof BotPatch>) if (!changed[key]) delete fields[key];
    }
    const input = editing
      ? fields
      : {
          ...fields,
          model: fields.model ?? undefined,
          id,
          avatar,
          avatarColor,
          defaultCwd: defaultCwd.trim() || undefined,
          ...(bot
            ? {
                mcpServers: bot.mcpServers,
                channels: bot.channels,
                order: bot.order,
              }
            : {}),
        };
    const result = editing ? botPatchSchema.safeParse(input) : botCreateSchema.safeParse(input);
    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        next[field] =
          field === 'id'
            ? t('validation.id')
            : field === 'name'
              ? t('validation.name')
              : field === 'persona'
                ? t('validation.persona')
                : field === 'memory'
                  ? t('validation.memory')
                  : field === 'avatar'
                    ? t('validation.avatar')
                    : field === 'defaultCwd'
                      ? t('validation.defaultCwd')
                      : t('validation.form');
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await onSave(result.data);
    } catch {
      if (mounted.current) setFailure(true);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const title = editing ? t('editor.edit') : duplicate ? t('editor.duplicate') : t('editor.create');
  const form = (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      noValidate
    >
      <fieldset disabled={creationSaved || disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className={styles.editorBody}>
        {failure && (
          <p className={styles.error} role="alert">
            {creationSaved ? text('chat.savedOpenFailed') : t('errors.save')}
          </p>
        )}
        {Object.keys(errors).length > 0 && (
          <div className={styles.error} role="alert">
            {Object.entries(errors).map(([field, message]) => (
              <p key={field} id={`${uid}-${field}-error`}>
                {message}
              </p>
            ))}
          </div>
        )}
        <div className={styles.formRow}>
          <label className={styles.field}>
            {t('editor.name')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={disabled}
              required
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? `${uid}-name-error` : undefined}
            />
          </label>
        </div>
        {avatarWarning && <p className={styles.warning}>{t('avatar.invalidStored')}</p>}
        <button type="button" className={styles.button} aria-label={t('editor.avatar')} aria-expanded={avatarOpen} disabled={disabled} onClick={() => setAvatarOpen(!avatarOpen)}>
          <BotAvatar bot={{ id, avatar, avatarColor, avatarVariant }} size={48} />
        </button>
        {avatarOpen && <AvatarPicker
          id={id}
          value={avatar}
          color={avatarColor}
          variant={avatarVariant}
          onVariantChange={setAvatarVariant}
          onChange={setAvatar}
          onColorChange={setAvatarColor}
          disabled={disabled}
          t={t}
        />}
        {!editing && <p className={styles.hint}>{text('chat.firstMessage')}</p>}
        <details data-compatibility-settings=""><summary>{text('chat.compatibility')}</summary>
        <label className={styles.field}>
          {t('editor.description')}
          <textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={disabled}
          />
        </label>
        <details><summary>{text('chat.advanced')}</summary>
        <label className={styles.field}>
          {t('editor.persona')}
          <textarea
            rows={6}
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            disabled={disabled}
            aria-invalid={Boolean(errors.persona)}
            aria-describedby={errors.persona ? `${uid}-persona-error` : undefined}
          />
        </label>
        <label className={styles.field}>
          {t('editor.template')}
          <select
            value={template}
            onChange={(event) => setTemplate(event.target.value as 'standard' | 'minimal')}
            disabled={disabled}
          >
            <option value="standard">{t('editor.templateStandard')}</option>
            <option value="minimal">{t('editor.templateMinimal')}</option>
          </select>
        </label>
        <label className={styles.field}>
          {t('manage.personaSuffix')}
          <textarea rows={3} value={suffix} disabled={disabled} onChange={(e) => setSuffix(e.target.value)} />
        </label>
        <label className={styles.checkboxField}>
          <input
            type="checkbox"
            checked={complete}
            disabled={disabled}
            onChange={(e) => setComplete(e.target.checked)}
          />
          {t('manage.personaComplete')}
        </label>
        </details>
        <fieldset disabled={disabled}>
          <legend>{t('manage.model')}</legend>
          <p className={styles.hint}>{t('manage.modelHint')}</p>
          <label className={styles.checkboxField}>
            <input type="checkbox" checked={modelEnabled} onChange={(e) => setModelEnabled(e.target.checked)} />
            {t('manage.modelOverride')}
          </label>
          {modelEnabled && (
            <>
              {models && <label className={styles.field}>{cap('capabilities.catalogModel')}
                <select value={JSON.stringify([provider, modelId])} onChange={event => {
                  const [nextProvider, nextModel] = JSON.parse(event.target.value) as [string, string];
                  setProvider(nextProvider); setModelId(nextModel); setReasoning('');
                }}>
                  <option value={JSON.stringify([provider, modelId])}>{provider && modelId ? `${provider} / ${modelId}` : cap('capabilities.modelDefault')}</option>
                  {(modelCatalog?.providers ?? []).map(route => <optgroup key={route.id} label={route.name}>
                    {route.models.filter(model => model.provider !== provider || model.id !== modelId).map(model => <option key={model.id} value={JSON.stringify([route.id, model.id])}>{model.name}</option>)}
                  </optgroup>)}
                </select>
                <span className={styles.hint}>{cap(modelCatalog?.error || modelCatalog?.providers.some(route => route.id === provider && !route.available) ? 'capabilities.modelUnavailable' : modelCatalog?.providers.some(route => route.id === provider && route.models.some(model => model.id === modelId)) ? 'capabilities.modelLoaded' : 'capabilities.modelUnknown')}</span>
              </label>}
              <label className={styles.field}>
                {t('manage.provider')}
                <input value={provider} onChange={(e) => setProvider(e.target.value)} />
              </label>
              <label className={styles.field}>
                {t('manage.modelId')}
                <input value={modelId} onChange={(e) => setModelId(e.target.value)} />
              </label>
              <label className={styles.field}>
                {t('manage.reasoning')}
                <input list={`${uid}-reasoning-values`} value={reasoning} onChange={(e) => setReasoning(e.target.value)} />
                <datalist id={`${uid}-reasoning-values`}>{efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}</datalist>
              </label>
            </>
          )}
        </fieldset>
        <label className={styles.field}>
          {t('manage.skillDirs')}
          <textarea rows={3} value={extraDirs} disabled={disabled} onChange={(e) => setExtraDirs(e.target.value)} />
        </label>
        <p className={styles.hint}>{t('manage.skillHint')}</p>
        {onPickDirectory && <button type="button" className={styles.button} disabled={disabled} onClick={() => {
          setPicking(true); setPickFailed(false);
          void onPickDirectory().then(path => { if (mounted.current && path) setExtraDirs(current => [...new Set([...current.split('\n').filter(Boolean), path])].join('\n')); },
            () => { if (mounted.current) setPickFailed(true); }).finally(() => { if (mounted.current) setPicking(false); });
        }}>{cap('capabilities.chooseDirectory')}</button>}

        <section data-bot-default-cwd="" className={styles.cwdSection} aria-label={t('editor.defaultCwd')}>
          <p className={styles.hint}>{t('editor.cwdHint')}</p>
          <label className={styles.field}>
            {t('editor.defaultCwd')}
            <input
              value={defaultCwd}
              disabled={disabled}
              placeholder={botsPath ?? t('editor.cwdPlaceholder')}
              onChange={(event) => setDefaultCwd(event.target.value)}
              aria-invalid={Boolean(errors.defaultCwd)}
              aria-describedby={`${uid}-cwd-hint${errors.defaultCwd ? ` ${uid}-defaultCwd-error` : ''}`}
            />
          </label>
          <p className={styles.hint} data-bots-workspace="" data-effective-cwd={defaultCwd.trim() ? undefined : ''}>
            {t('editor.cwdDefault', {
              path: botsPath ?? t(workspaceFailed ? 'editor.cwdWorkspaceUnavailable' : 'editor.cwdWorkspaceLoading'),
            })}
          </p>
          {defaultCwd.trim() && (
            <p className={styles.hint} data-effective-cwd="">
              {t('editor.cwdEffective', { path: defaultCwd.trim() })}
            </p>
          )}
          <p className={styles.hint} data-bot-home="">
            {t('editor.cwdHome', {
              path:
                home ??
                t(editing ? (homeFailed ? 'editor.cwdUnavailable' : 'editor.cwdLoading') : 'editor.cwdAfterSave'),
            })}
          </p>
          <div className={styles.actions}>
            {onPickDirectory && (
              <button
                type="button"
                className={styles.button}
                disabled={disabled}
                onClick={() => {
                  void chooseDirectory();
                }}
              >
                {t('editor.cwdChoose')}
              </button>
            )}
            <button
              type="button"
              className={styles.button}
              disabled={disabled || !defaultCwd}
              onClick={() => {
                setDefaultCwd('');
                setPickFailed(false);
              }}
            >
              {t('editor.cwdReset')}
            </button>
          </div>
          {homeFailed && (
            <p className={styles.error} role="alert">
              {t('editor.cwdHomeError')}{' '}
              <button
                type="button"
                className={styles.button}
                disabled={disabled}
                onClick={() => setHomeAttempt((value) => value + 1)}
              >
                {t('actions.retry')}
              </button>
            </p>
          )}
          {workspaceFailed && (
            <p className={styles.error} role="alert">
              {t('editor.cwdWorkspaceError')}{' '}
              <button
                type="button"
                className={styles.button}
                disabled={disabled}
                onClick={() => setHomeAttempt((value) => value + 1)}
              >
                {t('actions.retry')}
              </button>
            </p>
          )}
          {pickFailed && (
            <p className={styles.error} role="alert">
              {t('editor.cwdPickError')}
            </p>
          )}
          <p className={styles.hint} id={`${uid}-cwd-hint`}>
            {t('editor.cwdPermissions')}
          </p>
        </section>
        <details><summary>{text('chat.advanced')}</summary>
        <div className={styles.formRow}>
          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={memory}
              onChange={(event) => setMemory(event.target.checked)}
              disabled={disabled}
            />
            {t('editor.memory')}
          </label>
          <label className={styles.field}>
            {t('editor.injectLimit')}
            <input
              type="number"
              min={0}
              step={1}
              value={injectLimit}
              disabled={disabled}
              onChange={(event) => setInjectLimit(event.target.value)}
              aria-invalid={Boolean(errors.memory)}
              aria-describedby={`${uid}-memory-hint${errors.memory ? ` ${uid}-memory-error` : ''}`}
            />
            <span className={styles.hint} id={`${uid}-memory-hint`}>
              {t('editor.injectHint')}
            </span>
          </label>
        </div>
        {!memory && <p className={styles.notice}>{t('memory.disabled')}</p>}
        {memory && bot?.persona.complete && <p className={styles.notice}>{t('memory.complete')}</p>}
        <label className={styles.field}>
          {t('editor.hiddenTools')}
          <textarea
            rows={3}
            value={deny}
            onChange={(event) => setDeny(event.target.value)}
            disabled={disabled}
            aria-describedby={`${uid}-tools-hint`}
          />
          <span className={styles.hint} id={`${uid}-tools-hint`}>
            {t('editor.hiddenToolsHint')}
          </span>
        </label>
        </details>
        </details>
      </div>
      </fieldset>
      {!editing && !duplicate && <p role="note" className={styles.hint}>{t('onboarding.createNotice')}</p>}
      <footer className={styles.dialogFooter}>
        <button type="button" className={styles.button} onClick={onCancel} disabled={disabled}>
          {t('actions.cancel')}
        </button>
        <button type="submit" className={styles.primaryButton} disabled={disabled}>
          {disabled ? t('editor.saving') : editing ? t('editor.save') : text(creationSaved ? 'chat.openChat' : 'chat.createAndChat')}
        </button>
      </footer>
    </form>
  );
  return (
    <Modal title={title} description={editing ? t('bots.newSessionsNotice') : undefined} busy={disabled} onClose={onCancel} t={t}>
      {editing && memoryPanel && (
        <div className={styles.tabs} role="tablist" aria-label={t('editor.details')}>
          <button
            id={`${uid}-settings-tab`}
            type="button"
            role="tab"
            aria-selected={tab === 'settings'}
            aria-controls={`${uid}-settings-panel`}
            className={styles.button}
            disabled={disabled}
            onClick={() => setTab('settings')}
          >
            {t('editor.settings')}
          </button>
          <button
            id={`${uid}-memory-tab`}
            type="button"
            role="tab"
            aria-selected={tab === 'memory'}
            aria-controls={`${uid}-memory-panel`}
            className={styles.button}
            disabled={disabled}
            onClick={() => setTab('memory')}
          >
            {t('memory.title')}
          </button>
        </div>
      )}
      {tab === 'memory' && (
        <div id={`${uid}-memory-panel`} role="tabpanel" aria-labelledby={`${uid}-memory-tab`}>
          {memoryPanel}
        </div>
      )}
      {memoryPanel ? (
        <div
          id={`${uid}-settings-panel`}
          hidden={tab !== 'settings'}
          role="tabpanel"
          aria-labelledby={`${uid}-settings-tab`}
        >
          {form}
        </div>
      ) : (
        form
      )}
    </Modal>
  );
}
