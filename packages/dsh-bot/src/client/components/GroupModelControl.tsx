import { useEffect, useRef, useState } from 'react';
import { Button, IconChevronDownOutlineRegular, IconDataOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { groupKey, type GroupMember, type GroupModelSelection, type GroupRecord } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { unwrapGroup, type GroupActions } from '../groups-state.js';
import type { ModelActions, ModelCatalogData } from '../model-catalog-state.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/groups.module.css';

type Props = { group: GroupRecord; members?: GroupMember[]; bots?: BotRecord[]; actions: GroupActions; models: ModelActions; disabled?: boolean;
  onBusyChange?(busy: boolean): void; onSaved?(): Promise<void> } & PropsLocale<'dsh-bot'>;
const routeKey = (selection: GroupModelSelection) => JSON.stringify([selection.provider, selection.model]);
type Attempt = { selection: GroupModelSelection | null; memberId?: string; expectedModelRevision: number };

/** The native ModelSelect is private. Reuse public Menu/Button and its catalog. */
export function GroupModelControl(props: Props) {
  return <Control key={`${props.group.id}:${props.group.createdAt}`} {...props} />;
}
function Control({ group, members = [], bots = [], actions, models, disabled, onBusyChange, onSaved, t }: Props) {
  const [open, setOpen] = useState(false), [pane, setPane] = useState<'root' | 'member' | 'model' | 'effort'>('root');
  const [target, setTarget] = useState<string>();
  const active = members.filter(member => member.enabled && member.removedAt === undefined && member.group.groupId === group.id && member.group.groupCreatedAt === group.createdAt);
  const activeRef = useRef(active); activeRef.current = active;
  const botFor = (id: string) => { const member = active.find(row => row.id === id); return member && bots.find(bot => bot.id === member.bot.botId && bot.createdAt === member.bot.botCreatedAt); };
  const [providers, setProviders] = useState<ModelCatalogData['providers']>(() => models.catalog.getSnapshot().providers);
  const [metadata, setInfo] = useState<Awaited<ReturnType<ModelActions['modelInfo']>> | undefined>(() => group.modelSelection ? actions.modelMetadata?.get(routeKey(group.modelSelection)) : undefined);
  const [infoRoute, setInfoRoute] = useState(() => group.modelSelection ? routeKey(group.modelSelection) : undefined);
  const [receipt, setReceipt] = useState<GroupRecord>();
  // A model receipt must never restore stale membership or general group state.
  const current = receipt && (receipt.modelRevision ?? 0) > (group.modelRevision ?? 0)
    ? { ...group, modelRevision: receipt.modelRevision, modelSelection: receipt.modelSelection, memberModelSelections: receipt.memberModelSelections } : group;
  const effective = (id?: string) => {
    const own = id ? current.memberModelSelections?.find(row => row.memberId === id)?.modelSelection : undefined;
    const fallback = id ? botFor(id)?.model : undefined;
    return { selection: own ?? current.modelSelection ?? fallback,
      source: own ? t('groups.modelSourceMember') : current.modelSelection ? t('groups.modelSourceGroup') : fallback ? t('groups.modelSourceBot') : t('groups.modelSourceDsh') };
  };
  const selection = effective(target).selection;
  const info = selection && infoRoute === routeKey(selection) ? metadata : undefined;
  const latest = useRef(current); latest.current = current;
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false), [saveError, setSaveError] = useState(false);
  const failed = useRef<Attempt>();
  const alive = useRef(true), epoch = useRef(0), locked = useRef(false);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; busyCallback.current?.(false); }; }, []);
  const activeIds = JSON.stringify(active.map(row => row.id));
  useEffect(() => {
    const ids: string[] = JSON.parse(activeIds);
    if ((target && !ids.includes(target)) || (failed.current?.memberId && !ids.includes(failed.current.memberId))) {
      epoch.current++; setLoading(false); setOpen(false); setTarget(undefined); setPane('root'); failed.current = undefined; setSaveError(false);
    }
  }, [activeIds, target]);
  const load = async (selected?: GroupModelSelection) => {
    const request = ++epoch.current; setLoading(true); setLoadError(false);
    setInfoRoute(selected ? routeKey(selected) : undefined);
    setInfo(selected ? actions.modelMetadata?.get(routeKey(selected)) : undefined);
    try {
      // No subscription: the shared catalog only reads on demand here.
      await models.catalog.refresh();
      const snapshot = models.catalog.getSnapshot();
      if (snapshot.error || !snapshot.loaded) throw new Error('Model catalog unavailable');
      if (!alive.current || request !== epoch.current) return;
      setProviders(snapshot.providers);
      if (selected) {
        const value = await models.modelInfo(selected.provider, selected.model);
        if (alive.current && request === epoch.current) { actions.modelMetadata?.set(routeKey(selected), value); setInfoRoute(routeKey(selected)); setInfo(value); }
      }
    } catch { if (alive.current && request === epoch.current) setLoadError(true); }
    finally { if (alive.current && request === epoch.current) setLoading(false); }
  };
  const save = async (next: GroupModelSelection | null, retry?: Attempt) => {
    const attempt = retry ?? { selection: next, ...(target ? { memberId: target } : {}), expectedModelRevision: latest.current.modelRevision ?? 0 };
    if (locked.current || disabled || (attempt.memberId && !activeRef.current.some(row => row.id === attempt.memberId))) return;
    locked.current = true; setBusy(true); setSaveError(false); onBusyChange?.(true);
    const owner = latest.current;
    try {
      const saved = unwrapGroup(await actions.remote().setModel(groupKey(owner), {
        expectedModelRevision: attempt.expectedModelRevision, modelSelection: attempt.selection, ...(attempt.memberId ? { memberId: attempt.memberId } : {}),
      }));
      if (!alive.current) return;
      latest.current = { ...latest.current, modelSelection: saved.modelSelection, memberModelSelections: saved.memberModelSelections, modelRevision: saved.modelRevision };
      setReceipt(saved); failed.current = undefined; setOpen(false);
      // A refresh error cannot turn an accepted model change into a failed save.
      await Promise.allSettled([actions.catalog.refresh(), onSaved?.()]);
    } catch { if (alive.current && (!attempt.memberId || activeRef.current.some(row => row.id === attempt.memberId))) {
      failed.current = attempt; setSaveError(true); setOpen(false);
      await Promise.allSettled([actions.catalog.refresh(), onSaved?.()]);
    } }
    finally { locked.current = false; if (alive.current) { setBusy(false); onBusyChange?.(false); } }
  };
  const identityFor = (member: GroupMember) => {
    const name = botFor(member.id)?.name ?? member.bot.botId;
    const peers = active.filter(row => (botFor(row.id)?.name ?? row.bot.botId) === name && row.id !== member.id);
    if (!peers.length) return undefined;
    let length = 8;
    while (length < member.bot.botId.length && peers.some(row => row.bot.botId.slice(-length) === member.bot.botId.slice(-length))) length++;
    const suffix = member.bot.botId.slice(-length);
    return peers.some(row => row.bot.botId === member.bot.botId) ? `${suffix} · ${member.id.slice(-6)}` : suffix;
  };
  const labelFor = (value?: GroupModelSelection) => value ? providers.find(provider => provider.id === value.provider)?.models.find(model => model.id === value.model)?.name ?? value.model : t('groups.modelSourceDsh');
  const modelLabel = labelFor(selection);
  const effortLabel = selection?.reasoningEffort
    ? info?.reasoning?.efforts.find(effort => effort.id === selection.reasoningEffort)?.name ?? selection.reasoningEffort : undefined;
  const overrides = current.memberModelSelections?.some(row => active.some(member => member.id === row.memberId));
  const triggerLabel = overrides ? t('groups.modelPerBot') : current.modelSelection ? labelFor(current.modelSelection) : t('groups.modelDefault');
  const groupEffort = current.modelSelection?.reasoningEffort;
  const groupInfo = current.modelSelection ? actions.modelMetadata?.get(routeKey(current.modelSelection)) : undefined;
  const triggerEffort = !overrides && groupEffort ? groupInfo?.reasoning?.efforts.find(effort => effort.id === groupEffort)?.name ?? groupEffort : undefined;
  const modelId = (provider: string, model: string) => `model:${JSON.stringify([provider, model])}`;
  const effortId = (effort: string) => `effort:${effort}`;
  const resetLabel = target ? t('groups.modelFollowGroup') : t('groups.modelDefault');
  const settings: MenuEntry[] = [
    { id: 'models', label: <span className={styles.modelMenuValue}><span>{target ? t('groups.model') : t('groups.modelGroupDefault')}</span><span>{target || current.modelSelection ? modelLabel : t('groups.modelDefault')}</span></span>, disabled: busy },
    ...(selection && info?.reasoning ? [{ id: 'efforts', label: <span className={styles.modelMenuValue}><span>{t('groups.reasoning')}</span><span>{effortLabel ?? t('groups.reasoningDefault')}</span></span>, disabled: busy }] : []),
    ...((target ? current.memberModelSelections?.some(row => row.memberId === target) : current.modelSelection) ? [{ id: 'reset', label: resetLabel, disabled: busy }] : []),
  ];
  const targetMember = active.find(row => row.id === target);
  let items: MenuEntry[];
  if (pane === 'root') items = [
    ...settings,
    ...active.map(member => {
      const bot = botFor(member.id), value = effective(member.id);
      const providerLabel = value.selection ? providers.find(provider => provider.id === value.selection?.provider)?.name ?? value.selection.provider : undefined;
      const memberInfo = value.selection ? actions.modelMetadata?.get(routeKey(value.selection)) : undefined;
      const memberEffort = value.selection?.reasoningEffort;
      const effortName = memberEffort ? memberInfo?.reasoning?.efforts.find(effort => effort.id === memberEffort)?.name ?? memberEffort : undefined;
      const identity = identityFor(member);
      const detail = [labelFor(value.selection), providerLabel, effortName].filter(Boolean).join(' · ');
      return { id: `member:${member.id}`, disabled: busy, label: <span className={styles.modelMemberRow} data-model-member-id={member.id} data-model-bot-id={member.bot.botId} data-model-source={value.source}>
        {bot && <BotAvatar bot={bot} size={24} />}<span className={styles.modelMemberText}>
          <span className={styles.modelMemberName}><span className={styles.modelMemberLabel}>{bot?.name ?? member.bot.botId}</span>{identity && <small title={member.bot.botId}>{identity}</small>}</span>
          <span className={styles.modelMemberDetail} title={detail}>{detail}</span>
          <span className={styles.modelMemberSource}>{value.source}</span>
        </span></span> };
    }),
  ];
  else if (pane === 'member') items = [
    { id: 'back', label: t('groups.modelBack') },
    { type: 'label', id: 'member-title', text: [botFor(target ?? '')?.name ?? target, targetMember ? identityFor(targetMember) : undefined, effective(target).source].filter(Boolean).join(' · ') },
    ...settings,
    ...(!current.memberModelSelections?.some(row => row.memberId === target) ? [{ id: 'reset', label: resetLabel, disabled: busy }] : []),
  ];
  else if (pane === 'model') items = [
    { id: 'back', label: t('groups.modelBack') },
    { id: 'reset', label: resetLabel, disabled: busy },
    ...providers.flatMap(provider => [
      { type: 'label' as const, id: `provider:${provider.id}`, text: provider.name },
      ...provider.models.map(model => ({ id: modelId(provider.id, model.id), label: <span data-model-provider={provider.id} data-model-id={model.id}>{model.name}</span>, disabled: busy || !provider.available })),
    ]),
  ];
  else items = [
    { id: 'back', label: t('groups.modelBack') },
    { id: 'effort-default', label: t('groups.reasoningDefault'), disabled: busy },
    ...(info?.reasoning?.efforts ?? []).map(effort => ({ id: effortId(effort.id), label: effort.name, disabled: busy })),
  ];
  if (loading) items.push({ type: 'label', id: 'loading', text: t('groups.modelLoading') });
  if (loadError) items.push({ type: 'label', id: 'load-error', text: t('groups.modelLoadFailed') }, { id: 'reload', label: t('groups.modelRetry'), disabled: loading || busy });
  return <span className={styles.modelControl}>
    <Menu key={`${pane}:${target ?? ''}`} open={open} onClose={() => setOpen(false)} side="top" portal compact autoFocus
      className={styles.modelMenuAnchor} listClassName={styles.modelMenu} items={items}
      selectedIds={[selection ? modelId(selection.provider, selection.model) : 'reset', selection?.reasoningEffort ? effortId(selection.reasoningEffort) : 'effort-default']}
      anchor={<Button variant="ghost" size="sm" className={styles.modelTrigger} disabled={disabled || busy} title={t('groups.modelScope')}
        aria-label={`${t('groups.model')}: ${triggerLabel}${triggerEffort ? ` · ${triggerEffort}` : ''}`} aria-haspopup="menu" aria-expanded={open} aria-busy={busy}
        onClick={() => { if (locked.current) return; if (open) setOpen(false); else { setTarget(undefined); setPane('root'); failed.current = undefined; setSaveError(false); setOpen(true); void load(latest.current.modelSelection); } }}>
        <IconDataOutlineRegular size={16} /><span className={styles.modelTriggerLabel}>{triggerLabel}</span>
        {triggerEffort && <span className={styles.modelEffort}>{triggerEffort}</span>}<IconChevronDownOutlineRegular size={12} />
      </Button>}
      onSelect={id => {
        if (busy || disabled || (target && !activeRef.current.some(row => row.id === target))) return;
        if (id.startsWith('member:')) { const memberId = id.slice('member:'.length); if (!activeRef.current.some(row => row.id === memberId)) return; setTarget(memberId); setPane('member'); void load(effective(memberId).selection); }
        else if (id === 'models') setPane('model');
        else if (id === 'efforts') setPane('effort');
        else if (id === 'back') { if (pane === 'member') { setTarget(undefined); setPane('root'); void load(latest.current.modelSelection); } else setPane(target ? 'member' : 'root'); }
        else if (id === 'reload') void load(selection);
        else if (id === 'reset') void save(null);
        else if (id === 'effort-default' && selection) void save({ provider: selection.provider, model: selection.model });
        else if (id.startsWith('effort:') && selection) void save({ ...selection, reasoningEffort: id.slice('effort:'.length) });
        else {
          for (const provider of providers) for (const model of provider.models)
            if (id === modelId(provider.id, model.id) && provider.available) void save({ provider: provider.id, model: model.id });
        }
      }} />
    {open && loadError && <span role="alert" className={styles.srOnly}>{t('groups.modelLoadFailed')}</span>}
    {saveError && <span role="alert" className={styles.modelError}>{t('groups.modelSaveFailed')}
      <Button variant="ghost" size="sm" disabled={busy || disabled || (failed.current?.expectedModelRevision !== (current.modelRevision ?? 0))} onClick={() => { if (failed.current) void save(failed.current.selection, failed.current); }}>{t('groups.modelRetry')}</Button></span>}
  </span>;
}
