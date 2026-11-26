import { GroupExportQueue } from './GroupExportQueue.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import type { ExecutionBridge } from '../group-execution.js';
import { GroupStatisticsBar } from './GroupStatistics.js';
import { SettingsDrafts, useSettingsNavigation, useSettingsDraft, useSettingsLeave } from './SettingsNavigation.js';
import type { PageIdentity } from '../pages/page-navigation.js';
import { GroupComposerInput } from './GroupComposer.js';
import { GroupModelControl } from './GroupModelControl.js';
import { GroupPermissionControl } from './GroupPermissionControl.js';
import type { GroupPermissionState } from '../group-permission-state.js';
import { Button, IconDataOutlineRegular, IconDownloadOutlineRegular, IconPaperclipOutlineRegular, IconPlusOutlineRegular, IconPaperPlaneOutlineRegular, IconSendOutlineRegular, IconShieldOutlineRegular, Menu, PathLabel, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives';
import { availableGroupCommands, bareGroupCommand, GROUP_COMMANDS, type GroupCommandName, type GroupCommandServices } from '../group-commands.js';
import type { GroupCommandSource } from '../group-trigger.js';
import type { ModelActions } from '../model-catalog-state.js';
import { GroupTimeline, groupMessagePreview } from './GroupTimeline.js';
import { GroupDirectory } from './GroupDirectory.js';
import { GroupDeleteDialog } from './GroupDeleteDialog.js';
import { GroupMembersView, GroupOverview } from './GroupOverview.js';
import { RosterManagement } from './RosterManagement.js';
import { memoryOnlyIntent, singleMemoryReference } from '../../shared/group-memory-intent.js';
import { isGroupDelegation, matchAddressedBot, matchGroupAddress, relayNeedsTopic } from '../../shared/addressed-bot.js';
import { resolveGroupMentions } from '../group-mentions.js';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { GROUP_ATTACHMENT_LIMIT, GROUP_TEXT_MAX_BYTES, groupKey, type GroupSummary, type GroupView, type GroupSend, type GroupRecord } from '../../shared/groups.js';
import { GROUP_MEMBER_LIMIT } from '../../shared/group-limits.js';
import type { BotRecord } from '../../shared/schema.js';
import { GroupRouteUnavailable, type GroupActions, type GroupDraft, unwrapGroup } from '../groups-state.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/groups.module.css';
import css from '../styles/groups.module.css?inline';
const sendErrors = ['memory-text-required', 'mention-not-member', 'guest-ambiguous', 'guest-unavailable', 'guest-changed', 'relay-topic-required', 'member-limit', 'group-data-blocked', 'conflict'] as const;
const definitiveRejectionCodes = ['memory-text-required', 'mention-not-member', 'guest-ambiguous', 'guest-unavailable', 'guest-changed', 'relay-topic-required', 'member-limit', 'group-data-blocked', 'invalid', 'unavailable', 'approval-denied', 'unsupported', 'not-found'] as const;
const uncertainDraftErrors = new Set<NonNullable<GroupDraft['errorCode']>>(['send-failed', 'conflict', 'supergroup-conflict', 'route-unavailable']);
const safeErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return;
  return /^[a-z0-9-]+(?:\/[a-z0-9-]+)+$/i.test(error.code) ? error.code : undefined;
};
const isDefinitivePreDispatchRejection = (error: unknown): boolean =>
  definitiveRejectionCodes.some(code => hasOperationCode(error, code)) || safeErrorCode(error) === 'gateway/input-invalid';
const clearDefinitiveError = (value: GroupDraft): GroupDraft =>
  !value.error || !value.errorCode || uncertainDraftErrors.has(value.errorCode)
    ? value
    : { ...value, error: false, errorCode: undefined, errorDiagnostic: undefined };
const draftErrorText = {
  'mention-not-member': 'groups.mentionMembersOnly',
  'mention-required': 'groups.mentionRequired',
  'message-too-long': 'groups.messageTooLong',
  'followup-ended': 'groups.supplementEnded',
  'memory-text-required': 'groups.memoryStatus.needsText',
  'relay-topic-required': 'groups.relay.topicRequired',
  'guest-ambiguous': 'groups.guest.ambiguous',
  'guest-unavailable': 'groups.guest.unavailable',
  'guest-changed': 'groups.guest.changed',
  'group-data-blocked': 'groups.export.dataBlocked',
  'membership-changed': 'groups.sendMembershipChanged',
  'route-unavailable': 'groups.routeUnavailable',
  'supergroup-conflict': 'botMode.inputConflict',
  'supergroup-unsupported': 'botMode.inputUnsupported',
  'member-limit': 'groups.memberLimitFailed',
  'send-invalid': 'groups.sendInvalid',
  'send-unavailable': 'groups.sendUnavailable',
  'send-denied': 'groups.sendDenied',
  'send-unsupported': 'groups.sendUnsupported',
  'send-not-found': 'groups.sendNotFound',
  'send-failed': 'groups.export.sendFailed',
  conflict: 'groups.conflict',
} as const satisfies Record<NonNullable<GroupDraft['errorCode']>, string>;
const keyOf = (b: BotRecord) => ({ botId: b.id, botCreatedAt: b.createdAt });
const subscribeNoPermission = (_listener: () => void) => () => {};
/** Icon and copy of each '/' row, following the native composer menu's icons. */
const COMMAND_FACE = {
  file: { icon: IconPaperclipOutlineRegular, label: 'groups.commandFile', hint: 'groups.commandFileHint' },
  memory: { icon: IconDataOutlineRegular, label: 'groups.memoryStatus.toggle', hint: 'groups.memoryStatus.hint' },
  model: { icon: IconDataOutlineRegular, label: 'groups.commandModel', hint: 'groups.commandModelHint' },
  permission: { icon: IconShieldOutlineRegular, label: 'groups.commandPermission', hint: 'groups.commandPermissionHint' },
  export: { icon: IconDownloadOutlineRegular, label: 'groups.commandExport', hint: 'groups.commandExportHint' },
  feedback: { icon: IconPaperPlaneOutlineRegular, label: 'groups.commandFeedback', hint: 'groups.commandFeedbackHint' },
} as const;
type Localized = PropsLocale<'dsh-bot'>;
/** A Host-registered native Workspace offered as a group cwd. */
export interface GroupWorkspaceChoice { path: string; title: string }
export function GroupsPanel({
  actions,
  bots,
  onOpenSession,
  initialCreate = false,
  visible = true,
  selectedGroup, onSelectGroup, onOpenBot, onCreateFinished,
  workspaces, onPickDirectory,
  t,
}: {
  initialCreate?: boolean;
  visible?: boolean;
  /** Native Workspace catalog rows; the group cwd stays immutable after creation. */
  workspaces?: readonly GroupWorkspaceChoice[];
  /** Host-native directory picker; absent keeps a typed-path fallback. */
  onPickDirectory?: () => Promise<string | null>;
  selectedGroup?: PageIdentity;
  onSelectGroup?(value: PageIdentity | undefined): void;
  onOpenBot?(bot: BotRecord): void;
  onCreateFinished?(): void;
  actions: GroupActions;
  bots: BotRecord[];
  onOpenSession(id: string): Promise<void>;
} & Localized) {
  const navigation = useSettingsNavigation(t);
  const list = useSyncExternalStore(
    actions.catalog.subscribe,
    actions.catalog.getSnapshot,
    actions.catalog.getSnapshot,
  );
  const [selected, setSelected] = useState<PageIdentity>();
  const [deleting, setDeleting] = useState<GroupRecord>();
  const [deletedName, setDeletedName] = useState<string>();
  const listRef = useRef<HTMLElement>(null), origin = useRef<HTMLElement | null>(null), scroll = useRef(0);
  const back = () => {
    setSelected(undefined); onSelectGroup?.(undefined);
    requestAnimationFrame(() => { const page = listRef.current?.closest('[data-bots-page]')?.firstElementChild; if (page) page.scrollTop = scroll.current; origin.current?.focus({ preventScroll: true }); });
  };
  const [creating, setCreating] = useState(initialCreate);
  const [created, setCreated] = useState<GroupRecord>();
  const createdRef = useRef<GroupRecord>();
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(actions.turnExpansion),
  );
  const choice = onSelectGroup ? selectedGroup : selected;
  const active = list.groups.find(row => row.group.id === choice?.id && row.group.createdAt === choice.createdAt);
  const select = (group: GroupRecord) => {
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scroll.current = listRef.current?.closest('[data-bots-page]')?.firstElementChild?.scrollTop ?? 0;
    const identity = { id: group.id, createdAt: group.createdAt };
    setSelected(identity); onSelectGroup?.(identity); setCreating(false);
  };
  return (
    <SettingsDrafts.Provider value={navigation.registry}><section className={styles.panel} aria-label={t('groups.title')}>
      <style>{css}</style>
      {!initialCreate && <h2>{t('groups.title')}</h2>}
      {list.error && <p role="alert">{t('groups.disconnected')}</p>}
      {deletedName && <p role="status">{t('groups.deleted', { name: deletedName })}</p>}
      {list.loading && !list.loaded && <p role="status">{t('groups.loading')}</p>}
      <div className={initialCreate ? styles.content : styles.layout} data-group-selected={!!active || creating}>
        {!initialCreate && <nav ref={listRef} aria-label={t('groups.list')} className={styles.list}>
          <GroupDirectory rows={list.groups} bots={bots} selectedId={!creating ? active?.group.id : undefined}
            onSelect={group => { navigation.leave(() => select(group)); }}
            onDelete={group => { setDeletedName(undefined); setDeleting(group); }}
            onOpen={(group, signal) => actions.open(groupKey(group), signal)}
            onCreate={() => { createdRef.current = undefined; setCreated(undefined); setCreating(true); }}
            onRefresh={() => { void actions.catalog.refresh(); }} t={t} />
        </nav>}
        <div className={styles.content}>
          {active && !creating && <Button className={styles.groupBack} variant="ghost" onClick={() => navigation.leave(back)}>{t('navigation.returnTo', { name: t('groups.title') })}</Button>}
          {creating ? (
            <GroupEditor
              key="create"
              creationSaved={Boolean(created)}
              createdName={created?.name}
              bots={bots}
              workspaces={workspaces}
              onPickDirectory={onPickDirectory}
              t={t}
              onCancel={() => { setCreating(false); onCreateFinished?.(); }}
              onSave={async (input) => {
                if (!createdRef.current) {
                  const saved = unwrapGroup(await actions.remote().create(input));
                  createdRef.current = saved;
                  setCreated(saved);
                }
                const g = createdRef.current;
                await actions.catalog.refresh();
                await actions.open(groupKey(g));
                select(g); onCreateFinished?.();
              }}
            />
          ) : active ? (
            <GroupManager
              key={`${active.group.id}:${active.group.createdAt}`}
              expandedTurns={expandedTurns}
              onExpandTurn={(id, expanded) => {
                actions.turnExpansion.set(id, expanded);
                setExpandedTurns((old) => ({ ...old, [id]: expanded }));
              }}
              summary={active}
              onDelete={group => { setDeletedName(undefined); setDeleting(group); }}
              visible={visible}
              onOpenBot={onOpenBot}
              actions={actions}
              bots={bots}
              t={t}
              onOpenSession={onOpenSession}
            />
          ) : (
            <p>{t(list.groups.length ? 'navigation.selectGroup' : 'groups.empty')}</p>
          )}
        </div>
      </div>
      {navigation.confirmation}
      {deleting && <GroupDeleteDialog group={deleting} actions={actions} t={t} onClose={() => setDeleting(undefined)}
        onDeleted={group => {
          if (choice?.id === group.id && choice.createdAt === group.createdAt) back();
          setDeletedName(group.name);
        }} />}
    </section></SettingsDrafts.Provider>
  );
}
/** Group cwd from native Workspaces or the Host directory picker; it is the workspace-write boundary. */
function GroupWorkspaceField({ cwd, onChange, workspaces = [], onPickDirectory, disabled, t }: {
  cwd: string; onChange(value: string): void; workspaces?: readonly GroupWorkspaceChoice[];
  onPickDirectory?: () => Promise<string | null>; disabled: boolean;
} & Localized) {
  const [open, setOpen] = useState(false), [pickFailed, setPickFailed] = useState(false);
  const hintId = useId();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const known = workspaces.filter((row, index) => row.path && workspaces.findIndex(other => other.path === row.path) === index);
  const items: MenuEntry[] = [
    { id: 'default', label: t('groups.workspaceUseDefault') },
    ...(known.length ? [{ type: 'label' as const, id: 'known', text: t('groups.workspaceKnown') },
      ...known.map((row, index) => ({ id: `workspace:${index}`, label: <PathLabel path={row.path} /> }))] : []),
    ...(onPickDirectory ? [{ type: 'separator' as const, id: 'pick-separator' }, { id: 'pick', label: t('groups.workspaceOtherFolder') }] : []),
  ];
  const selectedIndex = known.findIndex(row => row.path === cwd);
  const choose = (id: string) => {
    setOpen(false); setPickFailed(false);
    if (disabled) return;
    if (id === 'default') onChange('');
    else if (id.startsWith('workspace:')) { const row = known[Number(id.slice('workspace:'.length))]; if (row) onChange(row.path); }
    else if (id === 'pick' && onPickDirectory) void onPickDirectory().then(path => { if (alive.current && path) onChange(path); },
      () => { if (alive.current) setPickFailed(true); });
  };
  return <fieldset className={styles.workspaceField} data-group-workspace="" aria-describedby={hintId}>
    <legend>{t('groups.cwd')}</legend>
    <div className={styles.workspaceValue}>
      {cwd ? <PathLabel path={cwd} /> : <span className={styles.workspaceDefault}>{t('groups.workspaceDefault')}</span>}
      <Menu open={open && !disabled} portal items={items} onSelect={choose} onClose={() => setOpen(false)}
        selectedId={cwd ? (selectedIndex >= 0 ? `workspace:${selectedIndex}` : undefined) : 'default'} listClassName={styles.workspaceMenu}
        anchor={<Button variant="outline" size="sm" disabled={disabled} aria-haspopup="menu" aria-expanded={open && !disabled}
          onClick={() => setOpen(!open)}>{t('groups.workspaceChoose')}</Button>} />
    </div>
    {!onPickDirectory && <input aria-label={t('groups.workspacePath')} disabled={disabled} value={cwd} onChange={(e) => onChange(e.target.value)} />}
    {pickFailed && <p role="alert">{t('groups.workspacePickFailed')}</p>}
    <p id={hintId} className={styles.workspaceHint}>{t('groups.workspaceHint')}</p>
  </fieldset>;
}
export function GroupEditor({
  bots,
  initial,
  creationSaved = false,
  createdName,
  onSave,
  onCancel,
  workspaces,
  onPickDirectory,
  t,
}: {
  bots: BotRecord[];
  workspaces?: readonly GroupWorkspaceChoice[];
  onPickDirectory?: () => Promise<string | null>;
  initial?: GroupView;
  creationSaved?: boolean;
  createdName?: string;
  onSave(input: {
    operationId: string;
    name: string;
    mode: GroupView['group']['mode'];
    onDemand?: boolean;
    members: ReturnType<typeof keyOf>[];
    cwd?: string;
    historyConfirmed: true;
  }): Promise<void>;
  onCancel(): void;
} & Localized) {
  const [name, setName] = useState(initial?.group.name ?? '');
  const editorForm = useRef<HTMLFormElement>(null);
  const editIdentity = initial ? JSON.stringify([initial.group.id, initial.group.createdAt]) : undefined;
  useEffect(() => {
    if (!editIdentity) return;
    editorForm.current?.scrollIntoView?.({ block: 'start' });
    editorForm.current?.querySelector<HTMLInputElement>('fieldset input:not(:disabled)')?.focus({ preventScroll: true });
  }, [editIdentity]);
  const [mode, setMode] = useState(initial?.group.mode ?? 'natural');
  const [onDemand, setOnDemand] = useState(initial ? initial.group.onDemand ?? false : true);
  const [members, setMembers] = useState(
    () => initial?.members.filter((m) => m.removedAt === undefined).map((m) => m.bot) ?? [],
  );
  const originalMembers = useRef(members);
  const limit = initial?.memberLimit ?? GROUP_MEMBER_LIMIT;
  const legacyOverLimit = originalMembers.current.length > limit;
  const canSaveMembers = members.length >= 2 && (legacyOverLimit
    ? members.length < originalMembers.current.length && members.every(member => originalMembers.current.some(original => original.botId === member.botId && original.botCreatedAt === member.botCreatedAt))
    : members.length <= limit);
  const [cwd, setCwd] = useState('');
  const initialDraft = useRef(JSON.stringify([name, mode, members, cwd, onDemand]));
  useSettingsDraft(JSON.stringify([name, mode, members, cwd, onDemand]) !== initialDraft.current);
  const leave = useSettingsLeave();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'conflict' | 'member-limit'>();
  const memberHintId = useId();
  const intent = useRef({
    operationId: `create:${crypto.randomUUID()}`,
    signature: '',
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const change = (next: typeof members) => {
    setMembers(next);
    setConfirmed(false);
  };
  return (
    <form
      ref={editorForm}
      className={styles.editor}
      aria-label={t(initial ? 'groups.edit' : 'groups.create')}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !confirmed || (!creationSaved && !canSaveMembers)) return;
        setBusy(true);
        setError(undefined);
        const input = {
          name: name.trim() || members.map(key => bots.find(bot => bot.id === key.botId && bot.createdAt === key.botCreatedAt)?.name ?? key.botId).join('、').slice(0, 120),
          mode,
          onDemand,
          members,
          ...(cwd ? { cwd } : {}),
          historyConfirmed: true as const,
        };
        const signature = JSON.stringify(input);
        if (intent.current.signature && intent.current.signature !== signature)
          intent.current.operationId = `create:${crypto.randomUUID()}`;
        intent.current.signature = signature;
        void onSave({ ...input, operationId: intent.current.operationId })
          .catch((cause: unknown) => {
            setError(hasOperationCode(cause, 'member-limit') ? 'member-limit' : 'conflict');
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      }}
    >
      <h3>{t(initial ? 'groups.edit' : 'groups.create')}</h3>
      {error && <p role="alert">{t(creationSaved ? 'groups.createdOpenFailed' : error === 'member-limit' ? 'groups.memberLimitFailed' : 'groups.conflict', { limit })}</p>}
      <label>
        {t('groups.name')}
        <input disabled={busy || creationSaved} value={creationSaved ? createdName ?? name : name} onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset aria-describedby={memberHintId}>
        <legend>{t('groups.members')}</legend>
        <p id={memberHintId} role="status">{t(legacyOverLimit ? 'groups.memberLimitLegacy' : 'groups.memberLimit', { count: members.length, limit })}</p>
        {bots.map((b) => {
          const selected = members.some((m) => m.botId === b.id && m.botCreatedAt === b.createdAt);
          return (
            <label key={`${b.id}:${b.createdAt}`}>
              <input
                type="checkbox"
                checked={selected}
                disabled={busy || creationSaved || (!selected && (legacyOverLimit || members.length >= limit))}
                onChange={(e) => {
                  if (e.target.checked && (legacyOverLimit || members.length >= limit)) return;
                  change(e.target.checked ? [...members, keyOf(b)] : members.filter((m) => m.botId !== b.id || m.botCreatedAt !== b.createdAt));
                }}
              />
              <BotAvatar bot={b} size={24} />
              {b.name} ({b.id})
            </label>
          );
        })}
      </fieldset>
      {!initial && <p>{t('simple.newGroupDefaults')}</p>}
      {!initial && <GroupWorkspaceField cwd={cwd} onChange={setCwd} workspaces={workspaces} onPickDirectory={onPickDirectory}
        disabled={busy || Boolean(creationSaved)} t={t} />}
      <details className={styles.advanced}><summary>{t('groups.advanced')}</summary>
      <label><input type="checkbox" checked={onDemand} disabled={busy || creationSaved || mode !== 'natural'} onChange={event => setOnDemand(event.target.checked)} />{t('teams.onDemand')}</label>
        <label>
        {t('groups.mode')}
        <select disabled={busy || creationSaved} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="natural">{t('groups.natural')}</option>
          <option value="mention">{t('groups.mention')}</option>
          <option value="round-robin">{t('groups.round-robin')}</option>
        </select>
      </label>
      <ol>
        {members.map((k, i) => (
          <li key={`${k.botId}:${k.botCreatedAt}`}>
            {bots.find((b) => b.id === k.botId && b.createdAt === k.botCreatedAt)?.name ??
              t('groups.unavailable')}{' '}
            ({k.botId})
            <button
              type="button"
              disabled={busy || creationSaved}
              aria-label={`${t('groups.removeMember')} ${k.botId}`}
              onClick={() => change(members.filter((m) => m !== k))}
            >
              {t('groups.removeMember')}
            </button>
            <button
              type="button"
              disabled={busy || creationSaved || i === 0}
              aria-label={`${t('groups.moveUp')} ${k.botId}`}
              onClick={() => {
                const next = [...members];
                [next[i - 1], next[i]] = [next[i] as typeof k, next[i - 1] as typeof k];
                change(next);
              }}
            >
              {t('groups.moveUp')}
            </button>
          </li>
        ))}
      </ol>
      </details>
      <p>{t('groups.capabilities')}</p>
      <label>
        <input
          type="checkbox"
          required
          checked={confirmed}
          disabled={busy || creationSaved}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {t('groups.historyConsent')}
      </label>
      <div className={styles.bar}>
        <button type="submit" disabled={busy || !confirmed || (!creationSaved && !canSaveMembers)}>
          {t(creationSaved ? 'groups.open' : 'integrations.save')}
        </button>
        <button type="button" disabled={busy} onClick={() => leave(onCancel)}>
          {t('groups.close')}
        </button>
      </div>
    </form>
  );
}
/** Compatibility export: all existing routes open the same native modal. */
export function GroupRosterEditor(props: {
  initial: GroupView; actions: GroupActions; bots: BotRecord[]; onClose(): void;
} & Localized) { return <RosterManagement {...props} />; }

export function GroupConversation({
  workspace = false,
  executionBridge,
  models,
  permissionState,
  commandServices,
  expandedTurns,
  onExpandTurn,
  summary,
  actions,
  bots,
  onOpenSession,
  t,
}: {
  workspace?: boolean;
  executionBridge?: ExecutionBridge;
  models?: ModelActions;
  permissionState?: GroupPermissionState;
  /** Native command bridge; local group actions remain available without it. */
  commandServices?: GroupCommandServices;
  expandedTurns: Record<string, boolean>;
  onExpandTurn(id: string, expanded: boolean): void;
  summary: GroupSummary;
  actions: GroupActions;
  bots: BotRecord[];
  onOpenSession(id: string): Promise<void>;
} & Localized) {
  const [statisticsSent, setStatisticsSent] = useState<{ turnId: string; followup: boolean; sequence: number }>();
  const [catalog] = useState(() => workspace ? actions.messageView(groupKey(summary.group)) : actions.createView(groupKey(summary.group)));
  useEffect(() => () => { if (!workspace) catalog.dispose(); }, [catalog, workspace]);
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
  const view = snapshot.view;
  const automaticGroup = Boolean(view?.group.supergroup ?? summary.group.supergroup);
  const runRequest = useSyncExternalStore(actions.runRequests.subscribe, actions.runRequests.getSnapshot);
  const focusRequest = workspace && runRequest?.sessionId === summary.group.rootSessionId ? runRequest : undefined;
  const focusMessageId = focusRequest?.source?.messageId ?? (focusRequest && view?.turns.find(row => row.id === focusRequest.turnId)?.inputMessageId);
  const { id: groupId, createdAt: groupCreatedAt } = summary.group;
  useEffect(() => {
    if (!focusRequest || !focusMessageId) return;
    const { requestId } = focusRequest;
    const group = { groupId, groupCreatedAt };
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && actions.runRequests.getSnapshot()?.requestId === requestId;
    let frame: number | undefined;
    void actions.quotedMessage(group, focusMessageId, controller.signal).then(async message => {
      if (!message || (focusRequest.source && message.seq !== focusRequest.source.seq) || !isCurrent()) return;
      await actions.loadThrough(group, message.seq);
      if (!isCurrent()) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!isCurrent()) return;
          const target = [...document.querySelectorAll<HTMLElement>('[data-workspace-group-message]')].find(element =>
            element.dataset.workspaceGroupMessage === message.id && element.dataset.workspaceGroup === `${groupId}:${groupCreatedAt}`);
          if (!target) return;
          actions.consumeRunRequest(requestId);
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.focus({ preventScroll: true });
        });
      });
    }).catch(() => {});
    return () => {
      controller.abort();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [actions, focusRequest, focusMessageId, groupId, groupCreatedAt]);
  const readSeq = view?.messages.at(-1)?.seq;
  useEffect(() => {
    if (!view?.unread || readSeq === undefined || document.visibilityState === 'hidden') return;
    let active = true;
    void actions
      .remote()
      .markRead(groupKey(view.group), readSeq, view.readRevision)
      .then(unwrapGroup)
      .then(async () => {
        if (active) await Promise.all([catalog.refresh(), actions.catalog.refresh()]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [actions, catalog, readSeq, view?.unread, view?.readRevision, view?.group]);
  const [mentionIssues, setMentionIssues] = useState<ReturnType<typeof resolveGroupMentions>['issues']>([]);
  const mentionAlerts = new Map(mentionIssues.map(issue => [issue.reason + ':' + issue.mention, issue]));
  const [guestIssue, setGuestIssue] = useState<'groups.memoryStatus.needsText' | 'groups.mentionMembersOnly' | 'groups.guest.changed' | 'groups.guest.unsupported' | 'groups.guest.ambiguous' | 'groups.relay.topicRequired'>();
  const rootId = summary.group.rootSessionId;
  const dispatchLifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController(); dispatchLifetime.current = controller;
    return () => controller.abort();
  }, []);
  useSyncExternalStore(actions.draftUpdates.subscribe, actions.draftUpdates.getSnapshot);
  const sharedDraft = actions.draft(rootId);
  const { text: draft, replyTo, uploads, mentions } = sharedDraft;
  const fieldSetter = <K extends keyof typeof sharedDraft>(key: K) => (value: typeof sharedDraft[K] | ((old: typeof sharedDraft[K]) => typeof sharedDraft[K])) =>
    actions.patchDraft(rootId, current => ({ ...current, [key]: typeof value === 'function' ? (value as (old: typeof sharedDraft[K]) => typeof sharedDraft[K])(current[key]) : value }));
  const setDraft = fieldSetter('text'), setReplyTo = fieldSetter('replyTo'), setUploads = fieldSetter('uploads'), setMentions = fieldSetter('mentions');
  const uploadControllers = useRef(new Map<string, AbortController>());
  const incomingReply = useSyncExternalStore(actions.replies.subscribe, actions.replies.getSnapshot);
  useEffect(() => { if (incomingReply?.sessionId === rootId) actions.consumeReply(rootId); }, [actions, incomingReply, rootId]);

  const [editing, setEditing] = useState<GroupView>();
  const [localBusy, setBusy] = useState(false), [modelBusy, setModelBusy] = useState(false);
  const permissionSaving = useSyncExternalStore(permissionState?.store.subscribe ?? subscribeNoPermission,
    () => Boolean(permissionState?.rootSessionId === rootId && permissionState?.store.getSnapshot().saving));
  const busy = localBusy || sharedDraft.sending || modelBusy || permissionSaving, error = sharedDraft.error;
  const setError = fieldSetter('error');
  const [older, setOlder] = useState<GroupView['messages']>([]);
  const [hasOlder, setHasOlder] = useState<boolean>();
  const operation = { get current() { return actions.draft(rootId).operation; }, set current(value: { signature: string; request: GroupSend } | undefined) { actions.patchDraft(rootId, current => ({ ...current, operation: value })); } };
  const composer = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);

  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      actions.patchDraft(rootId, current => ({ ...current, uploads: current.uploads.map(upload => upload.state === 'uploading' ? { ...upload, state: 'uploadFailed' } : upload) }));
      for (const controller of uploadControllers.current.values()) controller.abort();
      uploadControllers.current.clear();
    };
  }, [actions, rootId]);
  const [filesOverLimit, setFilesOverLimit] = useState(false);
  const attach = (files: FileList | null) => {
    // Automatic collaboration admits shared text only. Refuse before upload,
    // even if a file-input event arrives after the group changed or was hidden.
    if (!view || automaticGroup || !files) return;
    const remaining = Math.max(0, GROUP_ATTACHMENT_LIMIT - actions.draft(rootId).uploads.length);
    setFilesOverLimit(files.length > remaining);
    for (const file of Array.from(files).slice(0, remaining)) {
      const id = crypto.randomUUID(), controller = new AbortController();
      uploadControllers.current.set(id, controller);
      setUploads(current => [...current, { id, name: file.name, bytes: file.size, state: 'uploading' }]);
      void actions.upload(view.group.rootSessionId, file, controller.signal).then(receipt => {
        if (alive.current && !controller.signal.aborted)
          setUploads(current => current.map(row => row.id === id ? { ...row, ...receipt, state: 'uploaded' } : row));
      }).catch(() => {
        if (alive.current && !controller.signal.aborted)
          setUploads(current => current.map(row => row.id === id ? { ...row, state: 'uploadFailed' } : row));
      }).finally(() => uploadControllers.current.delete(id));
    }
  };
  const classifyError = (error: unknown, isFollowup = false, mentionMissingTarget = false): NonNullable<GroupDraft['errorCode']> => {
    if (error instanceof GroupRouteUnavailable) return 'route-unavailable';
    const mapped = sendErrors.find(code => hasOperationCode(error, code));
    if (mapped) return mapped;
    if (hasOperationCode(error, 'unavailable')) return isFollowup ? 'followup-ended' : 'send-unavailable';
    if (hasOperationCode(error, 'invalid') || safeErrorCode(error) === 'gateway/input-invalid')
      return mentionMissingTarget ? 'mention-required' : 'send-invalid';
    if (hasOperationCode(error, 'approval-denied')) return 'send-denied';
    if (hasOperationCode(error, 'unsupported')) return 'send-unsupported';
    if (hasOperationCode(error, 'not-found')) return 'send-not-found';
    return 'send-failed';
  };
  const perform = async (work: () => Promise<unknown>, options: { isFollowup?: boolean; mentionMissingTarget?: boolean } = {}) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    actions.patchDraft(rootId, value => ({ ...value, errorCode: undefined, errorDiagnostic: undefined }));
    try {
      await work();
      await Promise.all([catalog.refresh(), actions.catalog.refresh()]);
    } catch (error) {
      const diagnostic = safeErrorCode(error);
      const fallback = classifyError(error, options.isFollowup, options.mentionMissingTarget);
      let finalCode: NonNullable<GroupDraft['errorCode']> = fallback;
      actions.patchDraft(rootId, value => {
        finalCode = value.errorCode ?? fallback;
        return {
          ...value,
          errorCode: finalCode,
          errorDiagnostic: finalCode === 'send-failed' ? diagnostic : undefined,
        };
      });
      if (finalCode === 'send-failed') {
        if (diagnostic) console.warn('[dsh-bot] Group operation did not complete', { code: diagnostic });
        else console.warn('[dsh-bot] Group operation did not complete');
      }
      setError(true);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const availableMembers = (view?.members ?? []).filter(m => m.enabled && m.removedAt === undefined && !view?.unavailableMemberIds.includes(m.id));
  const memberBots = bots.filter(bot => availableMembers.some(m => m.bot.botId === bot.id && m.bot.botCreatedAt === bot.createdAt));
  const mentionTargets = availableMembers.map(m => ({
    id: m.id,
    botId: m.bot.botId,
    name: memberBots.find(b => b.id === m.bot.botId && b.createdAt === m.bot.botCreatedAt)?.name ?? m.bot.botId,
  }));
  const guestCandidates = automaticGroup ? [] : bots.filter(bot => !view?.members.some(member =>
    member.removedAt === undefined && member.bot.botId === bot.id && member.bot.botCreatedAt === bot.createdAt));
  const author = replyTo?.speaker?.bot;
  const replyAuthor = author && memberBots.find(bot => bot.id === author.botId && bot.createdAt === author.botCreatedAt);
  const addressed = automaticGroup ? undefined : matchGroupAddress(draft, bots, replyAuthor, memberBots);
  const guest = addressed?.kind === 'match' && guestCandidates.includes(addressed.bot) ? addressed.bot : undefined;
  const via = guest && addressed?.kind === 'match' ? addressed.via : undefined;
  const viaMember = via && mentionTargets.find(member => member.botId === via.id);
  const needsTopic = Boolean(guest && addressed?.kind === 'match' && relayNeedsTopic(addressed.question));
  const topicKey = guest ? JSON.stringify([rootId, via && keyOf(via), keyOf(guest), replyTo?.id, draft]) : undefined;
  const topic = topicKey && sharedDraft.relayTopic?.key === topicKey ? sharedDraft.relayTopic.text : '';
  const quoteExcerpt = needsTopic && replyTo && (!via || replyAuthor === via) ? groupMessagePreview(replyTo?.text) : '';
  const updateTopic = (text: string) => {
    if (!topicKey) return;
    actions.patchDraft(rootId, value => ({ ...value, relayTopic: { key: topicKey, text } }));
    setGuestIssue(undefined);
  };
  const resolveMentions = (text: string) => resolveGroupMentions(text, mentionTargets, mentions, sharedDraft.mentionBindings ?? []);
  const limit = view?.memberLimit ?? GROUP_MEMBER_LIMIT;
  const overMemberLimit = (view?.members.filter(member => member.removedAt === undefined).length ?? 0) > limit;
  const memoryIntent = automaticGroup ? undefined : memoryOnlyIntent(draft);
  const suggestedQuote = memoryIntent === 'reference' && !replyTo && sharedDraft.memoryReferenceId
    ? view?.messages.find(row => row.id === sharedDraft.memoryReferenceId) : undefined;
  const followupDelivery = sharedDraft.followup ? view?.deliveries.find(row => row.id === sharedDraft.followup?.deliveryId) : undefined;
  const followupTurn = sharedDraft.followup ? view?.turns.find(row => row.id === sharedDraft.followup?.turnId) : undefined;
  const followupEnded = Boolean(sharedDraft.followup && (
    (followupDelivery && (followupDelivery.state !== 'running' || followupDelivery.skipped)) ||
    (followupTurn && ['completed', 'partial', 'cancelled', 'idle', 'recovery_needed'].includes(followupTurn.state))
  ));
  const memoryConflict = Boolean(sharedDraft.followup && (sharedDraft.memoryStatusOnly || memoryIntent) ||
    sharedDraft.memoryStatusOnly && replyTo && !memoryIntent);
  const canSend = Boolean(view && !memoryConflict && uploads.length <= GROUP_ATTACHMENT_LIMIT && !overMemberLimit && !busy && !view.group.archived && !view.reason && view.group.state === 'ready' &&
    (draft.trim() || uploads.length) && uploads.every(row => row.state === 'uploaded'));
  const [modelOpen, setModelOpen] = useState(0), [permissionOpen, setPermissionOpen] = useState(0);
  const commandLauncher = useRef<() => void>();
  const permissionReady = useSyncExternalStore(permissionState?.store.subscribe ?? subscribeNoPermission,
    () => { const value = permissionState?.rootSessionId === rootId ? permissionState.store.getSnapshot() : undefined; return Boolean(value && value.currentValue !== undefined && value.catalog); });
  const usable = Boolean(view && !view.group.archived && view.group.state === 'ready');
  const local = { file: workspace && usable && !busy && !automaticGroup, model: Boolean(models) && usable && !localBusy && !sharedDraft.sending && !permissionSaving,
    memory: usable && !busy && !automaticGroup && !replyTo && !sharedDraft.followup && !sharedDraft.memoryStatusOnly,
    permission: permissionReady && usable && !busy };
  const commandState = useRef({ local }); commandState.current.local = local;
  const commandLabel = (name: GroupCommandName) => t(COMMAND_FACE[name].label);
  const runCommand = (name: GroupCommandName) => {
    if (name === 'file') { if (!automaticGroup) attachmentInput.current?.click(); }
    else if (name === 'memory') {
      if (commandState.current.local.memory) actions.patchDraft(rootId, value => ({ ...value, memoryStatusOnly: true }));
      composer.current?.focus({ preventScroll: true });
    }
    else if (name === 'model') setModelOpen(value => value + 1);
    else if (name === 'permission') setPermissionOpen(value => value + 1);
    else if (name === 'export') commandServices?.exportLog(rootId);
    else commandServices?.feedback(rootId);
  };
  const runRef = useRef(runCommand); runRef.current = runCommand;
  const rootRef = useRef(rootId); rootRef.current = rootId;
  const tRef = useRef(t); tRef.current = t;
  const [commands] = useState<GroupCommandSource>(() => ({
    async rows() {
      const host = await commandServices?.hostCommands(rootRef.current) ?? new Set<string>();
      const offered = availableGroupCommands(host, commandState.current.local, commandServices?.installed ?? (() => false));
      const translate = tRef.current;
      return offered.map(name => ({ name, label: translate(COMMAND_FACE[name].label), description: translate(COMMAND_FACE[name].hint), icon: COMMAND_FACE[name].icon,
        section: translate(name === 'file' || name === 'memory' ? 'groups.commandsAdd' : 'groups.commands') }));
    },
    run(name) { if ((GROUP_COMMANDS as readonly string[]).includes(name)) runRef.current(name as GroupCommandName); },
  }));
  const submit = (round: boolean) => {
    // A bare command typed as the whole draft runs as the command, never as a message, as in the
    // native composer. Like its Enter path, wait for the root's catalog rather than guess from the menu.
    const services = commandServices;
    const bare = !round && uploads.length === 0 ? bareGroupCommand(draft, GROUP_COMMANDS, commandLabel) : undefined;
    if (bare) {
      if (lock.current) return;
      const typed = draft;
      void (services?.hostCommands(rootId) ?? Promise.resolve(new Set<string>())).then(host => {
        const current = actions.draft(rootId);
        if (!alive.current || current.text !== typed || !availableGroupCommands(host, commandState.current.local, services?.installed ?? (() => false)).includes(bare)) return;
        actions.patchDraft(rootId, value => ({ ...value, text: '', mentionBindings: [], mentions: [] }));
        runRef.current(bare);
      });
      return;
    }
    if (!canSend || lock.current || !view) return;
    setGuestIssue(undefined);
    if (followupEnded) {
      actions.patchDraft(rootId, value => ({ ...value, error: true, errorCode: 'followup-ended', errorDiagnostic: undefined }));
      return;
    }
    if (new TextEncoder().encode(draft.trim()).length > GROUP_TEXT_MAX_BYTES) {
      actions.patchDraft(rootId, value => ({ ...value, error: true, errorCode: 'message-too-long', errorDiagnostic: undefined }));
      return;
    }
    if (memoryIntent === 'reference' && !replyTo && !suggestedQuote && !uploads.length) {
      setGuestIssue('groups.memoryStatus.needsText'); return;
    }
    let resolved = resolveMentions(draft);
    const picked = sharedDraft.mentionBindings?.filter(binding => binding.start >= 0 && draft.slice(binding.start, binding.end) === binding.text) ?? [];
    if (addressed?.kind === 'nonmember-mention' || picked.some(binding => binding.memberId.startsWith('guest:'))) {
      setGuestIssue('groups.mentionMembersOnly'); return;
    }
    if (resolved.issues.length) { setMentionIssues(resolved.issues); return; }
    const ambiguousRelay = addressed?.kind === 'ambiguous' && (isGroupDelegation(draft) || /^[@＠].+?\s(?:问|去问|请问|ask\b)/iu.test(draft.trim()));
    if (addressed?.kind === 'ambiguous' && (ambiguousRelay || !/^[@＠]/u.test(draft.trimStart()) && matchAddressedBot(draft, guestCandidates) &&
        !picked.some(binding => mentionTargets.some(member => member.id === binding.memberId)))) {
      setGuestIssue('groups.guest.ambiguous'); return;
    }
    if (guest && addressed?.kind === 'match') {
      resolved = resolveGroupMentions(addressed.question, mentionTargets);
      if (via && (!viaMember || picked.some(binding => binding.memberId !== viaMember.id))) {
        setGuestIssue('groups.guest.changed'); return;
      }
      if (needsTopic && !topic.trim()) { setGuestIssue('groups.relay.topicRequired'); return; }
      if (round || uploads.length || sharedDraft.followup || sharedDraft.memoryStatusOnly || resolved.memberIds.length || mentions.some(id => id !== viaMember?.id)) {
        setGuestIssue('groups.guest.unsupported'); return;
      }
      if (viaMember) resolved = { ...resolved, memberIds: [viaMember.id] };
    }
    setMentionIssues(resolved.issues);
    if (resolved.issues.length) return;
    const addressedMember = addressed?.kind === 'match' && memberBots.includes(addressed.bot);
    const mentionMissingTarget = !automaticGroup && !round && !sharedDraft.followup && !sharedDraft.memoryStatusOnly && !memoryIntent && !guest && !addressedMember && !replyAuthor && view.group.mode === 'mention' && resolved.memberIds.length === 0;
    if (mentions.some(id => !resolved.memberIds.includes(id)) || (sharedDraft.followup && (uploads.length || resolved.memberIds.length || replyTo))) { setError(true); return; }
    const reference = replyTo ?? suggestedQuote;
    const base = {
      expectedMembershipRevision: view.group.membershipRevision,
      ...(sharedDraft.followup ? { followup: sharedDraft.followup } : {}),
      ...(!automaticGroup && !sharedDraft.followup && (memoryIntent || !replyTo && sharedDraft.memoryStatusOnly) ? { memoryStatusOnly: true as const } : {}),
      text: draft,
      ...(guest ? { expectedGuest: keyOf(guest) } : {}),
      ...(via ? { expectedRelay: keyOf(via) } : {}),
      ...(needsTopic ? { relayTopic: topic.trim() } : {}),
      memberIds: round ? [] : resolved.memberIds,
      round,
      ...(reference ? { replyTo: reference.id } : {}),
      fileReceiptIds: uploads.flatMap(row => row.receiptId ? [row.receiptId] : []),
    };
    const signature = JSON.stringify({
      followup: base.followup,
      memoryStatusOnly: base.memoryStatusOnly,
      text: base.text,
      expectedGuest: base.expectedGuest,
      expectedRelay: base.expectedRelay,
      relayTopic: base.relayTopic,
      memberIds: base.memberIds,
      round: base.round,
      replyTo: base.replyTo,
      fileReceiptIds: base.fileReceiptIds,
    });
    if (operation.current?.signature !== signature)
      operation.current = {
        signature,
        request: { ...base, operationId: `send:${crypto.randomUUID()}` },
      };
    const pending = operation.current;
    const selectedAtSend = [...mentions];
    actions.patchDraft(rootId, value => ({ ...value, sending: true }));
    void perform(async () => {
      if (typeof actions.send !== 'function') throw new GroupRouteUnavailable();
      let turnId: string | undefined;
      try {
        ({ turnId } = await actions.send(groupKey(view.group), pending.request, dispatchLifetime.current.signal));
      } catch (cause) {
        if (!automaticGroup && !pending.request.followup && hasOperationCode(cause, 'conflict')) {
          await catalog.refresh();
          const snapshot = catalog.getSnapshot();
          const fresh = snapshot.view;
          // Only release the idempotency key after an authoritative rejection and
          // an updated roster with no recorded turn for this exact operation.
          if (!snapshot.error && fresh && fresh.group.id === view.group.id && fresh.group.createdAt === view.group.createdAt &&
              fresh.group.membershipRevision > pending.request.expectedMembershipRevision &&
              !fresh.turns.some(turn => turn.operationId === pending.request.operationId)) {
            actions.patchDraft(rootId, current => current.operation?.request.operationId === pending.request.operationId
              ? { ...current, operation: undefined, errorCode: 'membership-changed' } : current);
          }
        } else if (!automaticGroup && isDefinitivePreDispatchRejection(cause)) {
          actions.patchDraft(rootId, current => current.operation?.request.operationId === pending.request.operationId
            ? { ...current, operation: undefined } : current);
          if (pending.request.followup && hasOperationCode(cause, 'unavailable')) void catalog.refresh();
        }
        throw cause;
      }
      if (turnId) setStatisticsSent(previous => ({ turnId, followup: Boolean(pending.request.followup), sequence: (previous?.sequence ?? 0) + 1 }));
      actions.patchDraft(rootId, value => ({ ...value, mentionBindings: value.text === pending.request.text ? [] : value.mentionBindings,
        memoryReferenceId: value.text === pending.request.text ? undefined : value.memoryReferenceId,
        relayTopic: value.relayTopic?.key === topicKey ? undefined : value.relayTopic,
        memoryStatusOnly: pending.request.memoryStatusOnly ? undefined : value.memoryStatusOnly,
        followup: value.followup?.deliveryId === pending.request.followup?.deliveryId ? undefined : value.followup }));
      setDraft((current) => (current === pending.request.text ? '' : current));
        setMentions((current) => (JSON.stringify(current) === JSON.stringify(selectedAtSend) ? [] : current));
        setReplyTo(current => current?.id === pending.request.replyTo ? undefined : current);
        setUploads(current => current.filter(row => !row.receiptId || !pending.request.fileReceiptIds?.includes(row.receiptId)));
        operation.current = undefined;
        if (alive.current) setFilesOverLimit(false);
    }, { isFollowup: Boolean(pending.request.followup), mentionMissingTarget }).finally(() => actions.patchDraft(rootId, value => ({ ...value, sending: false })));
  };
  if (!view)
    return (
      <p role={snapshot.error ? 'alert' : 'status'}>
        {t(snapshot.error ? 'groups.disconnected' : 'groups.loading')}
      </p>
    );
  const members = view.members.filter((m) => m.enabled && m.removedAt === undefined);
  const lookup = (memberId: string) => {
    const m = view.members.find((m) => m.id === memberId);
    return bots.find((b) => b.id === m?.bot.botId && b.createdAt === m.bot.botCreatedAt);
  };
  const messages = [...new Map([...older, ...view.messages].map((m) => [m.id, m])).values()].sort(
    (a, b) => a.seq - b.seq,
  );
  return (
    <article className={`${styles.conversation} ${workspace ? `${styles.panel} ${styles.workspace}` : ''}`} aria-label={view.group.name} data-workspace-group-composer={workspace ? view.group.rootSessionId : undefined}>
      <style>{css}</style>
      {view.group.state === 'ready' && !view.group.archived && !view.hasEarlier && !view.messages.length && !view.turns.length && <p role="status" data-group-empty-conversation="">{t('groups.emptyConversation')}</p>}
      {overMemberLimit && <p role="status">{t('groups.memberLimitBlocked', { limit })}</p>}
      {(error || snapshot.error) && <p role="alert">{t(error ? draftErrorText[sharedDraft.errorCode ?? 'conflict'] : 'groups.disconnected', {
        limit, members: members.map(m => lookup(m.id)?.name ?? m.bot.botId).join(', '),
      })}{error && sharedDraft.errorCode === 'send-failed' && sharedDraft.errorDiagnostic ? ` (${sharedDraft.errorDiagnostic})` : ''}</p>}
      {(view.reason || view.group.state !== 'ready') && <p role="alert">{t('groups.recovery')}</p>}
      {!workspace && <>
      <h3>{view.group.name}</h3>
      <div className={styles.bar}>
        <span>{t(`groups.${view.group.mode}`)}</span>
        <button type="button" disabled={view.group.archived || view.group.state !== 'ready' || !!view.group.supergroup} onClick={() => setEditing(view)}>
          {t('groups.roster.manage')}
        </button>
        <button
          type="button"
          disabled={busy || view.group.archived}
          onClick={() => {
            void perform(async () =>
              unwrapGroup(await actions.remote().archive(groupKey(view.group), view.group.revision)),
            );
          }}
        >
          {t('groups.archive')}
        </button>
      </div>
      <p>{t('navigation.memberCount', { count: view.members.filter(member => member.removedAt === undefined).length })}</p>
      <GroupMembersView view={view} bots={bots} actions={actions} executionBridge={executionBridge} t={t} />
      {editing && (
        <GroupRosterEditor bots={bots} actions={actions} initial={editing} t={t} onClose={() => setEditing(undefined)} />
      )}
      {(hasOlder ?? view.hasEarlier) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void perform(async () => {
              const page = unwrapGroup(
                await actions.remote().view(groupKey(view.group), { beforeSeq: messages[0]?.seq }),
              );
              if (alive.current) {
                setOlder((old) => [...page.messages, ...old]);
                setHasOlder(page.hasEarlier);
              }
            });
          }}
        >
          {t('groups.older')}
        </button>
      )}
      <GroupTimeline
        actions={actions}
        view={view}
        messages={messages}
        lookup={lookup}
        expanded={expandedTurns}
        onExpand={onExpandTurn}
        busy={busy}
        onCancel={(turn) => {
          void perform(async () =>
            unwrapGroup(await actions.remote().cancel(groupKey(view.group), turn.id, turn.revision)),
          );
        }}
        onOpenSession={onOpenSession}
        onOpenAttachment={async (messageId, attachmentId) => {
          unwrapGroup(await actions.remote().openAttachment(groupKey(view.group), messageId, attachmentId));
        }}
        onPreviewAttachment={(_messageId, attachment) => actions.imageUrl(rootId, attachment)}
        onReply={message => {
          setReplyTo(message);
          composer.current?.focus({ preventScroll: true });
        }}
        t={t}
      />
      </>}
      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <GroupExportQueue key={JSON.stringify(groupKey(view.group))} view={view} bots={bots} actions={actions} t={t} />
        {!automaticGroup && sharedDraft.memoryStatusOnly && <div className={styles.memoryStatusTag} data-group-memory-status="" role="status" title={t('groups.memoryStatus.hint')}>
          <IconDataOutlineRegular size={16} /><span>{t('groups.memoryStatus.toggle')}</span>
          <Button variant="ghost" size="sm" type="button" data-group-memory-cancel="" aria-label={t('groups.memoryStatus.cancel')} title={t('groups.memoryStatus.cancel')}
            disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => { actions.patchDraft(rootId, value => clearDefinitiveError({ ...value, memoryStatusOnly: undefined })); composer.current?.focus({ preventScroll: true }); }}>×</Button>
        </div>}
        {suggestedQuote && <div className={styles.replyPreview} role="status" data-group-memory-reference="">
          <strong>{t('groups.memoryStatus.reference', { name: suggestedQuote.speaker?.name ?? t('groups.you') })}</strong>
          <span>{groupMessagePreview(suggestedQuote.text)}</span>
        </div>}
        {memoryConflict && <p role="alert">{t('groups.memoryStatus.incompatible')}</p>}
        {replyTo && <div className={styles.replyPreview} role="status">
          <strong>{t('groups.replying', { name: replyTo.speaker?.name ?? t('groups.you') })}</strong>
          <span>{groupMessagePreview(replyTo.text)}</span>
          <button type="button" onClick={() => { actions.patchDraft(rootId, value => clearDefinitiveError({ ...value, replyTo: undefined })); composer.current?.focus({ preventScroll: true }); }}>
            {t('groups.clearReply')}
          </button>
        </div>}
        {sharedDraft.followup && <div className={styles.replyPreview} role="status">
          {t('groups.supplement')} · {lookup(followupDelivery?.memberId ?? '')?.name ?? t('groups.unavailable')}
          {followupEnded && <span> · {t('groups.supplementEndedShort')}</span>}
          <button type="button" onClick={() => actions.patchDraft(rootId, value => clearDefinitiveError({ ...value, followup: undefined }))}>{t('groups.close')}</button>
        </div>}
        <GroupComposerInput sessionId={rootId} text={draft} bindings={sharedDraft.mentionBindings ?? []} targets={mentionTargets} inputRef={composer} t={t}
          commands={commands} commandLauncher={commandLauncher}
          onChange={(text, mentionBindings) => {
            actions.patchDraft(rootId, value => clearDefinitiveError({ ...value, text, mentionBindings, mentions: [],
              memoryReferenceId: !automaticGroup && !value.replyTo && !value.followup && memoryOnlyIntent(text) === 'reference'
                ? (memoryOnlyIntent(value.text) === 'reference' ? value.memoryReferenceId : singleMemoryReference(view)?.id) : undefined }));
            setMentionIssues([]); setGuestIssue(undefined);
          }} onSubmit={() => submit(false)} />
        <label hidden={workspace} style={workspace ? { display: 'none' } : undefined}>
          {t('groups.attach')}
          <input ref={attachmentInput} type="file" multiple disabled={busy || view.group.archived || automaticGroup} onChange={event => {
            attach(event.currentTarget.files); event.currentTarget.value = '';
          }} />
        </label>
        {(filesOverLimit || uploads.length > GROUP_ATTACHMENT_LIMIT) && <p role="alert">{t('groups.attachmentLimit', { limit: GROUP_ATTACHMENT_LIMIT })}</p>}
        {uploads.length > 0 && <ul className={styles.attachments} aria-label={t('groups.attachments')}>
          {uploads.map(upload => <li key={upload.id}>
            <span>{upload.name} · {upload.bytes.toLocaleString()} B · {t(`groups.${upload.state}`)}</span>
            <button type="button" disabled={busy} aria-label={t('groups.removeAttachment', { name: upload.name })} onClick={() => {
              setFilesOverLimit(false);
              uploadControllers.current.get(upload.id)?.abort();
              actions.patchDraft(rootId, value => clearDefinitiveError({ ...value, uploads: value.uploads.filter(row => row.id !== upload.id) }));
            }}>{t('groups.removeAttachment', { name: upload.name })}</button>
          </li>)}
        </ul>}
        {guest && via && <p role="status" data-group-relay-route="">{t('groups.relay.hint', { sender: via.name, guest: guest.name })}</p>}
        {needsTopic && topicKey && <>
          <label>{t('groups.relay.topicLabel')}
            <input type="text" data-group-relay-topic="" maxLength={2048} value={topic} disabled={busy}
              onChange={event => updateTopic(event.currentTarget.value)} />
          </label>
          {quoteExcerpt && !topic && <button type="button" disabled={busy} onClick={() => updateTopic(quoteExcerpt)}>
            {t('groups.relay.useQuoteExcerpt')}
          </button>}
        </>}
        {guest && !via && replyTo && <p role="status">{t('groups.guest.quoteHint', { name: guest.name })}</p>}
        {guestIssue && <p role="alert">{t(guestIssue)}</p>}
        {Array.from(mentionAlerts, ([key, issue]) => (
          <p role="alert" key={key}>
            @{issue.mention} ·{' '}
            {t(issue.reason === 'ambiguous' ? 'groups.ambiguousMention' : 'groups.mentionMembersOnly')}
          </p>
        ))}
        {!workspace && <p>{t('groups.routingHint')}</p>}
        <div className={`${styles.bar} ${styles.composerFooter}`} title={t('groups.keyboardHint')}>
          <Button variant="ghost" size="sm" className={styles.attachAction} aria-label={t(automaticGroup ? 'groups.commands' : 'groups.addOrCommand')} title={t(automaticGroup ? 'groups.commands' : 'groups.addOrCommand')} aria-haspopup="listbox"
            data-group-command-launcher="" disabled={view.group.archived} onMouseDown={event => event.preventDefault()} onClick={() => commandLauncher.current?.()}><IconPlusOutlineRegular size={18} /></Button>
          {models && <GroupModelControl group={view.group} members={view.members} bots={bots} actions={actions} models={models} disabled={localBusy || sharedDraft.sending || permissionSaving || view.group.archived || view.group.state !== 'ready'} openRequest={modelOpen || undefined} onBusyChange={setModelBusy} onSaved={() => catalog.refresh()} t={t} />}
          {permissionState && permissionState.rootSessionId === rootId && <GroupPermissionControl state={permissionState} cwd={view.group.cwd} disabled={busy || view.group.archived || view.group.state !== 'ready'} openRequest={permissionOpen || undefined} t={t} />}
          <span className={styles.keyboardHint}>{t('groups.keyboardHint')}</span>
          <div className={styles.sendActions}>
          <Button variant="primary" size="sm" className={styles.sendAction} aria-label={t('groups.send')} title={t('groups.send')}
            type="submit"
            disabled={!canSend}
          >
            {workspace ? <IconSendOutlineRegular size={18} /> : t('groups.send')}
          </Button>
          {view.group.mode !== 'natural' && <button
            type="button"
            disabled={!canSend}
            onClick={() => submit(true)}
          >
            {t('groups.round')}
          </button>}
          </div>
        </div>
      </form>
      {workspace && executionBridge?.statistics && <GroupStatisticsBar key={`${view.group.id}:${view.group.createdAt}`} view={view} bridge={executionBridge} bots={bots} sent={statisticsSent} t={t} />}
    </article>
  );
}

function GroupManager({ summary, actions, bots, t, onOpenBot, visible, onDelete }: Parameters<typeof GroupConversation>[0] & {
  onOpenBot?(bot: BotRecord): void; visible?: boolean; onDelete(group: GroupRecord): void;
}) {
  const [editing, setEditing] = useState<GroupView>();
  return <><GroupOverview summary={summary} actions={actions} bots={bots} onOpenBot={onOpenBot}
    onEdit={setEditing} onDelete={onDelete} visible={visible} t={t} />
    {editing && <GroupRosterEditor bots={bots} actions={actions} initial={editing} t={t} onClose={() => setEditing(undefined)} />}</>;
}
