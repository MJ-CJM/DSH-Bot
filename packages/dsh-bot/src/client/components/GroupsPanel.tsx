import { resolveGroupMentions } from '../group-mentions.js';
import { WhaleGlyph } from './WhaleGlyph.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { groupKey, type GroupSummary, type GroupView, type GroupSend } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { type GroupActions, unwrapGroup } from '../groups-state.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/groups.module.css';
import css from '../styles/groups.module.css?inline';
const keyOf = (b: BotRecord) => ({ botId: b.id, botCreatedAt: b.createdAt });
type Localized = PropsLocale<'dsh-bot'>;
export function GroupsPanel({
  actions,
  bots,
  onOpenSession,
  t,
}: { actions: GroupActions; bots: BotRecord[]; onOpenSession(id: string): Promise<void> } & Localized) {
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
  const [creating, setCreating] = useState(false);
  const active = list.groups.find((g) => g.group.id === (selected ?? requested.selectedId)) ?? list.groups[0];
  useEffect(() => {
    if (requested.selectedId) {
      setSelected(requested.selectedId);
      setCreating(false);
    }
  }, [requested.selectedId]);
  return (
    <section className={styles.panel} aria-label={t('groups.title')}>
      <style>{css}</style>
      <h2>{t('groups.title')}</h2>
      {list.error && <p role="alert">{t('groups.disconnected')}</p>}
      <div className={styles.bar}>
        <button type="button" onClick={() => setCreating(true)}>
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
      </div>
      {list.loading && !list.loaded && <p role="status">{t('groups.loading')}</p>}
      <div className={styles.layout}>
        <nav aria-label={t('groups.list')} className={styles.list}>
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
              <WhaleGlyph size={28} />
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
        </nav>
        <div className={styles.content}>
          {creating ? (
            <GroupEditor
              key="create"
              bots={bots}
              t={t}
              onCancel={() => setCreating(false)}
              onSave={async (input) => {
                const g = unwrapGroup(await actions.remote().create(input));
                await actions.catalog.refresh();
                setSelected(g.id);
                setCreating(false);
              }}
            />
          ) : active ? (
            <GroupConversation
              key={`${active.group.id}:${active.group.createdAt}`}
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
  onSave,
  onCancel,
  t,
}: {
  bots: BotRecord[];
  initial?: GroupView;
  onSave(input: {
    operationId: string;
    name: string;
    mode: 'mention' | 'round-robin';
    members: ReturnType<typeof keyOf>[];
    cwd?: string;
    historyConfirmed: true;
  }): Promise<void>;
  onCancel(): void;
} & Localized) {
  const [name, setName] = useState(initial?.group.name ?? '');
  const [mode, setMode] = useState(initial?.group.mode ?? 'mention');
  const [members, setMembers] = useState(() => initial?.members.filter((m) => m.enabled).map((m) => m.bot) ?? []);
  const [cwd, setCwd] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const intent = useRef({ operationId: `create:${crypto.randomUUID()}`, signature: '' });
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
        const input = { name, mode, members, ...(cwd ? { cwd } : {}), historyConfirmed: true as const };
        const signature = JSON.stringify(input);
        if (intent.current.signature && intent.current.signature !== signature)
          intent.current.operationId = `create:${crypto.randomUUID()}`;
        intent.current.signature = signature;
        void onSave({ ...input, operationId: intent.current.operationId })
          .catch(() => {
            if (alive.current) setError(true);
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      }}
    >
      <h3>{t(initial ? 'groups.edit' : 'groups.create')}</h3>
      {error && <p role="alert">{t('groups.conflict')}</p>}
      <label>
        {t('groups.name')}
        <input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        {t('groups.mode')}
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="mention">{t('groups.mention')}</option>
          <option value="round-robin">{t('groups.round-robin')}</option>
        </select>
      </label>
      {!initial && (
        <label>
          {t('groups.cwd')}
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </label>
      )}
      <fieldset>
        <legend>{t('groups.members')}</legend>
        {bots.map((b) => {
          const selected = members.some((m) => m.botId === b.id && m.botCreatedAt === b.createdAt);
          return (
            <label key={`${b.id}:${b.createdAt}`}>
              <input
                type="checkbox"
                checked={selected}
                onChange={(e) =>
                  change(e.target.checked ? [...members, keyOf(b)] : members.filter((m) => m.botId !== b.id))
                }
              />
              <BotAvatar bot={b} size={24} />
              {b.name} ({b.id} · {b.createdAt})
            </label>
          );
        })}
      </fieldset>
      <ol>
        {members.map((k, i) => (
          <li key={`${k.botId}:${k.botCreatedAt}`}>
            {bots.find((b) => b.id === k.botId && b.createdAt === k.botCreatedAt)?.name ?? t('groups.unavailable')} (
            {k.botId})
            <button
              type="button"
              aria-label={`${t('groups.removeMember')} ${k.botId}`}
              onClick={() => change(members.filter((m) => m !== k))}
            >
              {t('groups.removeMember')}
            </button>
            <button
              type="button"
              disabled={i === 0}
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
      <p>{t('groups.capabilities')}</p>
      <label>
        <input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        {t('groups.historyConsent')}
      </label>
      <div className={styles.bar}>
        <button type="submit" disabled={busy || !confirmed || members.length < 2}>
          {t('integrations.save')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('groups.close')}
        </button>
      </div>
    </form>
  );
}
function GroupConversation({
  summary,
  actions,
  bots,
  onOpenSession,
  t,
}: {
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
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState<GroupView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [older, setOlder] = useState<GroupView['messages']>([]);
  const [hasOlder, setHasOlder] = useState<boolean>();
  const operation = useRef<{ signature: string; request: GroupSend }>();
  const composer = useRef<HTMLTextAreaElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (picker) pickerRef.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
  }, [picker]);
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const perform = async (work: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    try {
      await work();
      await Promise.all([catalog.refresh(), actions.catalog.refresh()]);
    } catch {
      if (alive.current) setError(true);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const submit = (round: boolean) => {
    if (!view || !draft.trim()) return;
    const resolved = resolveGroupMentions(
      draft,
      view.members
        .filter((m) => m.enabled && m.removedAt === undefined)
        .map((m) => ({
          id: m.id,
          botId: m.bot.botId,
          name: bots.find((b) => b.id === m.bot.botId && b.createdAt === m.bot.botCreatedAt)?.name ?? m.bot.botId,
        })),
      mentions,
    );
    setMentionIssues(resolved.issues);
    // Unmatched text remains ordinary group text. Valid recipients and round-robin can still proceed.
    if (!round && view.group.mode === 'mention' && !resolved.memberIds.length) return;
    const base = {
      expectedMembershipRevision: view.group.membershipRevision,
      text: draft,
      memberIds: round ? [] : resolved.memberIds,
      round,
    };
    const signature = JSON.stringify({ text: base.text, memberIds: base.memberIds, round: base.round });
    if (operation.current?.signature !== signature)
      operation.current = { signature, request: { ...base, operationId: `send:${crypto.randomUUID()}` } };
    const pending = operation.current;
    void perform(async () => {
      unwrapGroup(await actions.remote().send(groupKey(view.group), pending.request));
      if (alive.current) {
        setDraft((current) => (current === pending.request.text ? '' : current));
        setMentions((current) =>
          JSON.stringify(current) === JSON.stringify(pending.request.memberIds) ? [] : current,
        );
        operation.current = undefined;
      }
    });
  };
  if (!view)
    return (
      <p role={snapshot.error ? 'alert' : 'status'}>{t(snapshot.error ? 'groups.disconnected' : 'groups.loading')}</p>
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
    <article className={styles.conversation} aria-label={view.group.name}>
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
      {(error || snapshot.error) && <p role="alert">{t(error ? 'groups.conflict' : 'groups.disconnected')}</p>}
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
      <div ref={timeline} className={styles.timeline} role="log" aria-label={t('groups.timeline')} aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={styles.message} data-group-message={m.id}>
            <div className={styles.bar}>
              {m.speaker && (
                <BotAvatar
                  bot={{
                    id: m.speaker.bot.botId,
                    avatar: m.speaker.avatar,
                    avatarColor: m.speaker.avatarColor,
                    avatarVariant: m.speaker.avatarVariant,
                  }}
                  size={32}
                  label={m.speaker.name}
                />
              )}
              <strong>{m.speaker?.name ?? t('groups.you')}</strong>
              {m.speaker && (
                <small>
                  {m.speaker.bot.botId} · {m.speaker.bot.botCreatedAt}
                </small>
              )}
              <time dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString()}</time>
            </div>
            <p>{m.text}</p>
            {m.hasNonText && <p>{t('groups.nonText')}</p>}
            {m.stopReason && m.stopReason !== 'completed' && (
              <p role="status">
                {t('groups.partial')} · {m.stopReason}
              </p>
            )}
          </div>
        ))}
      </div>
      <section aria-label={t('groups.turns')}>
        {view.turns.map((turn) => (
          <div key={turn.id} className={styles.turn}>
            <span>{t(`groups.${turn.state}`)}</span>
            {['accepted', 'running'].includes(turn.state) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void perform(async () =>
                    unwrapGroup(await actions.remote().cancel(groupKey(view.group), turn.id, turn.revision)),
                  );
                }}
              >
                {t('groups.cancelTurn')}
              </button>
            )}
            {view.deliveries
              .filter((d) => d.turnId === turn.id)
              .map((d) => (
                <div key={d.id}>
                  {lookup(d.memberId)?.name ?? d.bot.botId} · {t(`groups.${d.state}`)}{' '}
                  {d.reasonCode ? t('groups.failureHint') : ''}
                  {d.contextTruncated && <span>{t('groups.truncated')}</span>}
                  {d.childSessionId && (
                    <button
                      type="button"
                      onClick={() => {
                        void onOpenSession(d.childSessionId ?? '');
                      }}
                    >
                      {t('groups.child')}
                    </button>
                  )}
                </div>
              ))}
          </div>
        ))}
      </section>
      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <label>
          {t('groups.message')}
          <textarea
            ref={composer}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setMentionIssues([]);
            }}
            onKeyDown={(e) => {
              if (e.key === '@') {
                setPicker(true);
              }
              if (e.key === 'Escape') {
                setPicker(false);
                composer.current?.focus();
              }
            }}
          />
        </label>
        <div className={styles.bar}>
          <button type="button" aria-expanded={picker} onClick={() => setPicker((v) => !v)}>
            {t('groups.pick')}
          </button>
          {mentions.map((id) => (
            <button key={id} type="button" onClick={() => setMentions((old) => old.filter((m) => m !== id))}>
              @{lookup(id)?.name ?? id} ×
            </button>
          ))}
        </div>
        {picker && (
          <fieldset
            ref={pickerRef}
            className={styles.picker}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setPicker(false);
                composer.current?.focus();
              }
            }}
          >
            <legend>{t('groups.targets')}</legend>
            {members.map((m) => (
              <label key={m.id}>
                <input
                  type="checkbox"
                  checked={mentions.includes(m.id)}
                  disabled={view.unavailableMemberIds.includes(m.id)}
                  onChange={(e) =>
                    setMentions((old) => (e.target.checked ? [...old, m.id] : old.filter((id) => id !== m.id)))
                  }
                />
                {lookup(m.id)?.name ?? t('groups.unavailable')} ({m.bot.botId} · {m.bot.botCreatedAt})
              </label>
            ))}
            <button
              type="button"
              onClick={() => {
                setPicker(false);
                composer.current?.focus();
              }}
            >
              {t('groups.close')}
            </button>
          </fieldset>
        )}
        {mentionIssues.map((issue) => (
          <p role="alert" key={issue.mention}>
            @{issue.mention} · {t(issue.reason === 'ambiguous' ? 'groups.ambiguousMention' : 'groups.unknownMention')}
          </p>
        ))}
        <p>{t('groups.routingHint')}</p>
        <div className={styles.bar}>
          <button
            type="submit"
            disabled={
              busy ||
              view.group.archived ||
              Boolean(view.reason) ||
              view.group.state !== 'ready' ||
              !draft.trim() ||
              (view.group.mode === 'mention' && !mentions.length && !draft.includes('@'))
            }
          >
            {t('groups.send')}
          </button>
          <button
            type="button"
            disabled={busy || !draft.trim() || view.group.archived || Boolean(view.reason)}
            onClick={() => submit(true)}
          >
            {t('groups.round')}
          </button>
        </div>
      </form>
    </article>
  );
}
