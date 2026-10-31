import { GroupComposerInput } from './GroupComposer.js';
import { GroupModelControl } from './GroupModelControl.js';
import { GroupPermissionControl } from './GroupPermissionControl.js';
import type { GroupPermissionState } from '../group-permission-state.js';
import { Button, IconPaperclipOutlineRegular, IconSendOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ModelActions } from '../model-catalog-state.js';
import { GroupTimeline, groupMessagePreview } from './GroupTimeline.js';
import { resolveGroupMentions } from '../group-mentions.js';
import { GroupAvatar } from './GroupAvatar.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { groupKey, type GroupSummary, type GroupView, type GroupSend, type GroupRecord } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { type GroupActions, unwrapGroup } from '../groups-state.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/groups.module.css';
import css from '../styles/groups.module.css?inline';
const keyOf = (b: BotRecord) => ({ botId: b.id, botCreatedAt: b.createdAt });
const subscribeNoPermission = (_listener: () => void) => () => {};
type Localized = PropsLocale<'dsh-bot'>;
export function GroupsPanel({
  actions,
  bots,
  onOpenSession,
  initialCreate = false,
  t,
}: {
  initialCreate?: boolean;
  actions: GroupActions;
  bots: BotRecord[];
  onOpenSession(id: string): Promise<void>;
} & Localized) {
  const list = useSyncExternalStore(
    actions.catalog.subscribe,
    actions.catalog.getSnapshot,
    actions.catalog.getSnapshot,
  );
  const requested = useSyncExternalStore(
    actions.selection.subscribe,
    actions.selection.getSnapshot,
    actions.selection.getSnapshot,
  );
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(initialCreate);
  const [created, setCreated] = useState<GroupRecord>();
  const createdRef = useRef<GroupRecord>();
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(actions.turnExpansion),
  );
  const active = list.groups.find((g) => g.group.id === (selected ?? requested.selectedId)) ?? list.groups[0];
  useEffect(() => {
    if (requested.selectedId && !initialCreate) {
      setSelected(requested.selectedId);
      setCreating(false);
    }
  }, [requested.selectedId, initialCreate]);
  return (
    <section className={styles.panel} aria-label={t('groups.title')}>
      <style>{css}</style>
      {!initialCreate && <h2>{t('groups.title')}</h2>}
      {list.error && <p role="alert">{t('groups.disconnected')}</p>}
      {!initialCreate && <div className={styles.bar}>
        <button type="button" onClick={() => { createdRef.current = undefined; setCreated(undefined); setCreating(true); }}>
          {t('groups.create')}
        </button>
        <button
          type="button"
          onClick={() => {
            void actions.catalog.refresh();
          }}
        >
          {t('bots.refresh')}
        </button>
      </div>}
      {list.loading && !list.loaded && <p role="status">{t('groups.loading')}</p>}
      <div className={initialCreate ? styles.content : styles.layout}>
        {!initialCreate && <nav aria-label={t('groups.list')} className={styles.list}>
          {list.groups.map((row) => (
            <button
              type="button"
              key={row.group.id}
              aria-current={!creating && active?.group.id === row.group.id ? 'page' : undefined}
              onClick={() => {
                setSelected(row.group.id);
                setCreating(false);
              }}
            >
              <GroupAvatar size={28} />
              <span className={styles.bar}>
                {row.members
                  .filter((m) => m.enabled)
                  .map((m) => {
                    const b = bots.find((b) => b.id === m.bot.botId && b.createdAt === m.bot.botCreatedAt);
                    return b ? <BotAvatar key={m.id} bot={b} size={22} /> : <span key={m.id}>?</span>;
                  })}
              </span>
              {row.group.name}{' '}
              {row.unread && (
                <span role="status" aria-label={t('groups.unread')}>
                  ●
                </span>
              )}{' '}
              {row.latest?.speaker?.name ?? ''} · {row.members.filter((m) => m.enabled).length}{' '}
              {row.running ? t('groups.running') : row.group.archived ? t('groups.archived') : ''}
            </button>
          ))}
        </nav>}
        <div className={styles.content}>
          {creating ? (
            <GroupEditor
              key="create"
              creationSaved={Boolean(created)}
              createdName={created?.name}
              bots={bots}
              t={t}
              onCancel={() => setCreating(false)}
              onSave={async (input) => {
                if (!createdRef.current) {
                  const saved = unwrapGroup(await actions.remote().create(input));
                  createdRef.current = saved;
                  setCreated(saved);
                }
                const g = createdRef.current;
                await actions.catalog.refresh();
                await actions.open(groupKey(g));
                setSelected(g.id);
                setCreating(false);
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
              actions={actions}
              bots={bots}
              t={t}
              onOpenSession={onOpenSession}
            />
          ) : (
            <p>{t('groups.empty')}</p>
          )}
        </div>
      </div>
    </section>
  );
}
function GroupEditor({
  bots,
  initial,
  creationSaved = false,
  createdName,
  onSave,
  onCancel,
  t,
}: {
  bots: BotRecord[];
  initial?: GroupView;
  creationSaved?: boolean;
  createdName?: string;
  onSave(input: {
    operationId: string;
    name: string;
    mode: GroupView['group']['mode'];
    members: ReturnType<typeof keyOf>[];
    cwd?: string;
    historyConfirmed: true;
  }): Promise<void>;
  onCancel(): void;
} & Localized) {
  const [name, setName] = useState(initial?.group.name ?? '');
  const [mode, setMode] = useState(initial?.group.mode ?? 'natural');
  const [members, setMembers] = useState(
    () => initial?.members.filter((m) => m.enabled).map((m) => m.bot) ?? [],
  );
  const [cwd, setCwd] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
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
      className={styles.editor}
      aria-label={t(initial ? 'groups.edit' : 'groups.create')}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !confirmed || members.length < 2) return;
        setBusy(true);
        setError(false);
        const input = {
          name: name.trim() || members.map(key => bots.find(bot => bot.id === key.botId && bot.createdAt === key.botCreatedAt)?.name ?? key.botId).join('、').slice(0, 120),
          mode,
          members,
          ...(cwd ? { cwd } : {}),
          historyConfirmed: true as const,
        };
        const signature = JSON.stringify(input);
        if (intent.current.signature && intent.current.signature !== signature)
          intent.current.operationId = `create:${crypto.randomUUID()}`;
        intent.current.signature = signature;
        void onSave({ ...input, operationId: intent.current.operationId })
          .catch(() => {
            setError(true);
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      }}
    >
      <h3>{t(initial ? 'groups.edit' : 'groups.create')}</h3>
      {error && <p role="alert">{t(creationSaved ? 'groups.createdOpenFailed' : 'groups.conflict')}</p>}
      <label>
        {t('groups.name')}
        <input disabled={busy || creationSaved} value={creationSaved ? createdName ?? name : name} onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset>
        <legend>{t('groups.members')}</legend>
        {bots.map((b) => {
          const selected = members.some((m) => m.botId === b.id && m.botCreatedAt === b.createdAt);
          return (
            <label key={`${b.id}:${b.createdAt}`}>
              <input
                type="checkbox"
                checked={selected}
                disabled={busy || creationSaved}
                onChange={(e) =>
                  change(e.target.checked ? [...members, keyOf(b)] : members.filter((m) => m.botId !== b.id))
                }
              />
              <BotAvatar bot={b} size={24} />
              {b.name} ({b.id})
            </label>
          );
        })}
      </fieldset>
      <details className={styles.advanced}>
        <summary>{t('groups.advanced')}</summary>
        <label>
        {t('groups.mode')}
        <select disabled={busy || creationSaved} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="natural">{t('groups.natural')}</option>
          <option value="mention">{t('groups.mention')}</option>
          <option value="round-robin">{t('groups.round-robin')}</option>
        </select>
      </label>
      {!initial && (
        <label>
          {t('groups.cwd')}
          <input disabled={busy || creationSaved} value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </label>
      )}
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
        <button type="submit" disabled={busy || !confirmed || members.length < 2}>
          {t(creationSaved ? 'groups.open' : 'integrations.save')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('groups.close')}
        </button>
      </div>
    </form>
  );
}
export function GroupConversation({
  workspace = false,
  models,
  permissionState,
  expandedTurns,
  onExpandTurn,
  summary,
  actions,
  bots,
  onOpenSession,
  t,
}: {
  workspace?: boolean;
  models?: ModelActions;
  permissionState?: GroupPermissionState;
  expandedTurns: Record<string, boolean>;
  onExpandTurn(id: string, expanded: boolean): void;
  summary: GroupSummary;
  actions: GroupActions;
  bots: BotRecord[];
  onOpenSession(id: string): Promise<void>;
} & Localized) {
  const [catalog] = useState(() => actions.createView(groupKey(summary.group)));
  useEffect(() => () => catalog.dispose(), [catalog]);
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
  const view = snapshot.view;
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
  const rootId = summary.group.rootSessionId;
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
  const attach = (files: FileList | null) => {
    if (!view || !files) return;
    for (const file of files) {
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
  const perform = async (work: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    try {
      await work();
      await Promise.all([catalog.refresh(), actions.catalog.refresh()]);
    } catch {
      setError(true);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const mentionTargets = (view?.members ?? [])
    .filter((m) => m.enabled && m.removedAt === undefined && !view?.unavailableMemberIds.includes(m.id))
    .map((m) => ({
      id: m.id,
      botId: m.bot.botId,
      name: bots.find((b) => b.id === m.bot.botId && b.createdAt === m.bot.botCreatedAt)?.name ?? m.bot.botId,
    }));
  const resolveMentions = (text: string) => resolveGroupMentions(text, mentionTargets, mentions, sharedDraft.mentionBindings ?? []);
  const canSend = Boolean(view && !busy && !view.group.archived && !view.reason && view.group.state === 'ready' &&
    (draft.trim() || uploads.length) && uploads.every(row => row.state === 'uploaded'));
  const submit = (round: boolean) => {
    if (!canSend || lock.current || !view) return;
    const resolved = resolveMentions(draft);
    setMentionIssues(resolved.issues);
    if (mentions.some(id => !resolved.memberIds.includes(id)) || resolved.issues.length || (sharedDraft.followup && (uploads.length || resolved.memberIds.length || replyTo))) { setError(true); return; }
    const base = {
      expectedMembershipRevision: view.group.membershipRevision,
      ...(sharedDraft.followup ? { followup: sharedDraft.followup } : {}),
      text: draft,
      memberIds: round ? [] : resolved.memberIds,
      round,
      ...(replyTo ? { replyTo: replyTo.id } : {}),
      fileReceiptIds: uploads.flatMap(row => row.receiptId ? [row.receiptId] : []),
    };
    const signature = JSON.stringify({
      followup: base.followup,
      text: base.text,
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
      unwrapGroup(await actions.remote().send(groupKey(view.group), pending.request));
      actions.patchDraft(rootId, value => ({ ...value, mentionBindings: value.text === pending.request.text ? [] : value.mentionBindings, followup: value.followup?.deliveryId === pending.request.followup?.deliveryId ? undefined : value.followup }));
      setDraft((current) => (current === pending.request.text ? '' : current));
        setMentions((current) => (JSON.stringify(current) === JSON.stringify(selectedAtSend) ? [] : current));
        setReplyTo(current => current?.id === pending.request.replyTo ? undefined : current);
        setUploads(current => current.filter(row => !row.receiptId || !pending.request.fileReceiptIds?.includes(row.receiptId)));
        operation.current = undefined;
    }).finally(() => actions.patchDraft(rootId, value => ({ ...value, sending: false })));
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
      {(error || snapshot.error) && <p role="alert">{t(error ? 'groups.conflict' : 'groups.disconnected')}</p>}
      {(view.reason || view.group.state !== 'ready') && <p role="alert">{t('groups.recovery')}</p>}
      {!workspace && <>
      <h3>{view.group.name}</h3>
      <div className={styles.bar}>
        <span>{t(`groups.${view.group.mode}`)}</span>
        <button type="button" onClick={() => setEditing(view)}>
          {t('groups.edit')}
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
      {(error || snapshot.error) && (
        <p role="alert">{t(error ? 'groups.conflict' : 'groups.disconnected')}</p>
      )}
      {(view.reason || view.group.state !== 'ready') && <p role="alert">{t('groups.recovery')}</p>}
      <section className={styles.members} aria-label={t('groups.members')}>
        {members.map((m) => {
          const b = lookup(m.id);
          return (
            <span key={m.id}>
              {b && <BotAvatar bot={b} size={28} />}
              {b?.name ?? t('groups.unavailable')} ({m.bot.botId}){' '}
              {view.unavailableMemberIds.includes(m.id) && t('groups.unavailable')}
            </span>
          );
        })}
      </section>
      {editing && (
        <GroupEditor
          bots={bots}
          initial={editing}
          t={t}
          onCancel={() => setEditing(undefined)}
          onSave={async (input) => {
            const { operationId: _op, cwd: _cwd, ...edit } = input;
            unwrapGroup(
              await actions.remote().edit(groupKey(view.group), {
                ...edit,
                expectedRevision: editing.group.revision,
                expectedMembershipRevision: editing.group.membershipRevision,
              }),
            );
            await Promise.all([catalog.refresh(), actions.catalog.refresh()]);
            if (alive.current) setEditing(undefined);
          }}
        />
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
        onReply={message => {
          setReplyTo(message);
          composer.current?.focus({ preventScroll: true });
        }}
        t={t}
      />
      </>}
      {workspace && <section className={styles.working} aria-label={t('groups.working')}>
        {view.turns.filter(turn => ['accepted', 'running'].includes(turn.state)).map(turn => <div key={turn.id} className={styles.bar} data-group-working={turn.id}>
          <span>{view.deliveries.filter(delivery => delivery.turnId === turn.id && delivery.state === 'running').map(delivery => lookup(delivery.memberId)?.name ?? delivery.bot.botId).join(' · ')} {t(view.deliveries.some(delivery => delivery.turnId === turn.id && delivery.state === 'running') ? 'groups.running' : 'groups.queued')} · {groupMessagePreview(messages.find(message => message.id === turn.inputMessageId)?.text, 120) || messages.find(message => message.id === turn.inputMessageId)?.attachments?.[0]?.attachment.name || t('groups.working')}</span>
          {view.deliveries.filter(delivery => delivery.turnId === turn.id && delivery.state === 'running').map(delivery => <button type="button" key={delivery.id} onClick={() => { actions.patchDraft(rootId, value => ({ ...value, followup: { turnId: turn.id, deliveryId: delivery.id }, replyTo: undefined, mentions: [], mentionBindings: [] })); composer.current?.focus(); }}>{t('groups.supplement')} · {lookup(delivery.memberId)?.name ?? delivery.bot.botId}</button>)}
          <button type="button" disabled={busy} onClick={() => { void perform(async () => unwrapGroup(await actions.remote().cancel(groupKey(view.group), turn.id, turn.revision))); }}>{t('groups.cancelTurn')}</button>
        </div>)}
        {view.deliveries.filter(delivery => ['failed', 'unknown'].includes(delivery.state)).map(delivery =>
          <p key={delivery.id} role="status">{lookup(delivery.memberId)?.name ?? delivery.bot.botId} · {t(`groups.${delivery.state}`)}</p>)}
      </section>}
      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        {replyTo && <div className={styles.replyPreview} role="status">
          <strong>{t('groups.replying', { name: replyTo.speaker?.name ?? t('groups.you') })}</strong>
          <span>{groupMessagePreview(replyTo.text)}</span>
          <button type="button" onClick={() => { setReplyTo(undefined); composer.current?.focus({ preventScroll: true }); }}>
            {t('groups.clearReply')}
          </button>
        </div>}
        {sharedDraft.followup && <div className={styles.replyPreview} role="status">{t('groups.supplement')} · {lookup(view.deliveries.find(row => row.id === sharedDraft.followup?.deliveryId)?.memberId ?? '')?.name ?? t('groups.unavailable')}
          <button type="button" onClick={() => actions.patchDraft(rootId, value => ({ ...value, followup: undefined }))}>{t('groups.close')}</button></div>}
        <GroupComposerInput sessionId={rootId} text={draft} bindings={sharedDraft.mentionBindings ?? []} targets={mentionTargets} inputRef={composer} t={t}
          onChange={(text, mentionBindings) => { actions.patchDraft(rootId, value => ({ ...value, text, mentionBindings, mentions: [] })); setMentionIssues([]); }} onSubmit={() => submit(false)} />
        <label hidden={workspace} style={workspace ? { display: 'none' } : undefined}>
          {t('groups.attach')}
          <input ref={attachmentInput} type="file" multiple disabled={busy || view.group.archived} onChange={event => {
            attach(event.currentTarget.files); event.currentTarget.value = '';
          }} />
        </label>
        {uploads.length > 0 && <ul className={styles.attachments} aria-label={t('groups.attachments')}>
          {uploads.map(upload => <li key={upload.id}>
            <span>{upload.name} · {upload.bytes.toLocaleString()} B · {t(`groups.${upload.state}`)}</span>
            <button type="button" disabled={busy} aria-label={t('groups.removeAttachment', { name: upload.name })} onClick={() => {
              uploadControllers.current.get(upload.id)?.abort();
              setUploads(current => current.filter(row => row.id !== upload.id));
            }}>{t('groups.removeAttachment', { name: upload.name })}</button>
          </li>)}
        </ul>}
        {mentionIssues.length > 0 && <p role="alert">{t('groups.chooseMention')}</p>}
        {mentionIssues.map((issue) => (
          <p role="alert" key={issue.mention}>
            @{issue.mention} ·{' '}
            {t(issue.reason === 'ambiguous' ? 'groups.ambiguousMention' : 'groups.unknownMention')}
          </p>
        ))}
        {!workspace && <p>{t('groups.routingHint')}</p>}
        <div className={`${styles.bar} ${styles.composerFooter}`} title={t('groups.keyboardHint')}>
          {workspace && <Button variant="ghost" size="sm" className={styles.attachAction} aria-label={t('groups.attach')} title={t('groups.attach')} disabled={busy || view.group.archived} onClick={() => attachmentInput.current?.click()}><IconPaperclipOutlineRegular size={18} /></Button>}
          {models && <GroupModelControl group={view.group} members={view.members} bots={bots} actions={actions} models={models} disabled={localBusy || sharedDraft.sending || permissionSaving || view.group.archived || view.group.state !== 'ready'} onBusyChange={setModelBusy} onSaved={() => catalog.refresh()} t={t} />}
          {permissionState && permissionState.rootSessionId === rootId && <GroupPermissionControl state={permissionState} disabled={busy || view.running || view.turns.some(turn => turn.state === 'accepted' || turn.state === 'running') || view.group.archived || view.group.state !== 'ready'} t={t} />}
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
    </article>
  );
}

function GroupManager({ summary, actions, bots, t }: Parameters<typeof GroupConversation>[0]) {
  const navigation = useRef(new AbortController());
  useEffect(() => {
    if (navigation.current.signal.aborted) navigation.current = new AbortController();
    const owner = navigation.current;
    return () => owner.abort();
  }, []);
  const [catalog] = useState(() => actions.createView(groupKey(summary.group)));
  useEffect(() => () => catalog.dispose(), [catalog]);
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
  const view = snapshot.view;
  const [editing, setEditing] = useState<GroupView>(), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError(false);
    try { await work(); await Promise.all([catalog.refresh(), actions.catalog.refresh()]); }
    catch { setError(true); } finally { setBusy(false); }
  };
  if (!view) return <p role="status">{t('groups.loading')}</p>;
  return <article aria-label={view.group.name} className={styles.conversation}>
    <h3>{view.group.name}</h3>
    <p>{view.members.filter(member => member.enabled).map(member => bots.find(bot => bot.id === member.bot.botId && bot.createdAt === member.bot.botCreatedAt)?.name ?? member.bot.botId).join(' · ')}</p>
    {error && <p role="alert">{t('groups.conflict')}</p>}
    <button type="button" disabled={busy} onClick={() => { void perform(() => actions.open(groupKey(view.group), navigation.current.signal)); }}>{t('groups.open')}</button>
    <button type="button" disabled={busy} onClick={() => setEditing(view)}>{t('groups.edit')}</button>
    <button type="button" disabled={busy || view.group.archived} onClick={() => { void perform(async () => { unwrapGroup(await actions.remote().archive(groupKey(view.group), view.group.revision)); }); }}>{t('groups.archive')}</button>
    {editing && <GroupEditor bots={bots} initial={editing} t={t} onCancel={() => setEditing(undefined)} onSave={async input => {
      const { operationId: _operation, cwd: _cwd, ...edit } = input;
      unwrapGroup(await actions.remote().edit(groupKey(view.group), { ...edit, expectedRevision: editing.group.revision,
        expectedMembershipRevision: editing.group.membershipRevision }));
      await catalog.refresh(); await actions.catalog.refresh(); setEditing(undefined);
    }} />}
  </article>;
}
