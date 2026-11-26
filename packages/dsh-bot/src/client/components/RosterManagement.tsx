import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { groupKey, groupMemberEditResultSchema, type GroupView } from '../../shared/groups.js';
import { sameBot, type BotKey } from '../../shared/identity.js';
import { GROUP_MEMBER_LIMIT } from '../../shared/group-limits.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import type { BotRecord } from '../../shared/schema.js';
import { unwrapGroup, type GroupActions } from '../groups-state.js';
import { formatList } from '../format.js';
import { BotAvatar } from './BotAvatar.js';
import { SettingsDrafts, useSettingsNavigation } from './SettingsNavigation.js';
import type { GroupMethods } from '../../shared/groups-contract.js';
import { Modal } from './Modal.js';
import styles from '../styles/roster.module.css';
import css from '../styles/roster.module.css?inline';
import dialogStyles from '../styles/bots.module.css';
import { useStyleSheet } from '../use-style-sheet.js';

type Localized = PropsLocale<'dsh-bot'>;
export const rosterMembers = (view: GroupView) => view.members.filter(member => member.removedAt === undefined).sort((a, b) => a.order - b.order);
export const rosterAddedMembers = (view: GroupView, target: readonly BotKey[]) => target.filter(key => !rosterMembers(view).some(member => sameBot(member.bot, key)));
export function rosterMemberName(view: GroupView, key: BotKey, bots: readonly BotRecord[]) {
  return bots.find(bot => bot.id === key.botId && bot.createdAt === key.botCreatedAt)?.name
    ?? view.messages.find(message => message.speaker && sameBot(message.speaker.bot, key))?.speaker?.name ?? key.botId;
}
export function memberEditingReason(view: GroupView) {
  return view.group.supergroup ? 'groups.roster.managed' : view.group.archived ? 'groups.roster.archived'
    : view.group.state !== 'ready' ? 'groups.roster.recovery' : undefined;
}

/** The same explicit audience review is used by the roster editor and saved-team application. */
export function MemberChangeReview({ view, target, bots, t }: {
  view: GroupView; target: readonly BotKey[]; bots: readonly BotRecord[];
} & Localized) {
  const added = rosterAddedMembers(view, target);
  const removed = rosterMembers(view).filter(member => !target.some(key => sameBot(key, member.bot)));
  const names = (keys: readonly BotKey[]) => formatList(keys.map(key => {
    const name = rosterMemberName(view, key, bots);
    const candidates = [...rosterMembers(view).map(member => member.bot), ...target];
    return candidates.some(other => !sameBot(other, key) && rosterMemberName(view, other, bots) === name) ? `${name} · ${key.botId}` : name;
  }), t('activity.locale'));
  return <div className={styles.review} data-member-change-review="">
    {added.length > 0 && <><p>{t('groups.roster.addSummary', { names: names(added) })}</p>
      <p>{t('groups.roster.historyScope', { names: names(added) })}</p></>}
    {removed.length > 0 && <><p>{t('groups.roster.removeSummary', { names: names(removed.map(member => member.bot)) })}</p>
      <p>{t('groups.roster.removeImpact')}</p></>}
    {(added.length > 0 || removed.length > 0) && <p>{t('groups.roster.exportsChanged')}</p>}
    {!added.length && !removed.length && <p>{t('groups.roster.orderSummary')}</p>}
  </div>;
}

type SavePhase = 'idle' | 'saving' | 'saved' | 'unknown' | 'conflict' | 'failed';
/** A transport failure never replays a mutation: query its persisted operation receipt first. */
export function useRosterSave(actions: GroupActions, view: GroupView, target: readonly BotKey[], onClose: () => void,
  submit?: (operationId: string) => Promise<Awaited<ReturnType<GroupMethods['editMembers']>>>, afterRefresh?: () => Promise<unknown>) {
  const key = groupKey(view.group);
  const identity = JSON.stringify(key);
  actions.memberEdits ??= new Map();
  const pending = actions.memberEdits;
  const previous = pending.get(identity);
  const [phase, setPhase] = useState<SavePhase>(() => previous?.phase === 'saved' ? 'saved' : previous ? 'unknown' : 'idle');
  const [refreshFailed, setRefreshFailed] = useState(previous?.phase === 'saved');
  const [latest, setLatest] = useState<GroupView>();
  const [failureKey, setFailureKey] = useState('groups.roster.failed');
  const lock = useRef(false);
  const operation = useRef<string | undefined>(previous?.operationId);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refreshSaved = async () => {
    setRefreshFailed(false);
    try { await actions.refreshRoster(key); await afterRefresh?.(); pending.delete(identity); if (mounted.current) onClose(); }
    catch { setRefreshFailed(true); }
  };
  const markSaved = async () => {
    const entry = pending.get(identity);
    if (entry) entry.phase = 'saved';
    setPhase('saved'); await refreshSaved();
  };
  const refresh = async () => {
    if (lock.current) return;
    lock.current = true;
    try { await refreshSaved(); } finally { lock.current = false; }
  };
  const loadLatest = async () => {
    if (lock.current) return;
    lock.current = true;
    try { setLatest(unwrapGroup(await actions.remote().view(key, {}))); }
    catch { setLatest(undefined); }
    finally { lock.current = false; }
  };
  const receiptValue = (result: Awaited<ReturnType<GroupMethods['editMembers']>>) => {
    const receipt = groupMemberEditResultSchema.parse(unwrapGroup(result));
    if (receipt.operationId !== operation.current || (receipt.group && (receipt.group.id !== key.groupId || receipt.group.createdAt !== key.groupCreatedAt)))
      throw new Error('Receipt identity mismatch');
    return receipt;
  };
  const markNotFound = () => {
    pending.delete(identity);
    operation.current = undefined;
    setFailureKey('groups.roster.failed');
    setPhase('failed');
  };
  const check = async () => {
    if (!operation.current || lock.current) return;
    lock.current = true; setPhase('saving');
    try {
      const receipt = receiptValue(await actions.remote().getMemberEditResult(key, operation.current));
      if (receipt.status === 'saved') { await markSaved(); }
      else if (receipt.status === 'not-found') { markNotFound(); }
      else setPhase('unknown');
    } catch { setPhase('unknown'); }
    finally { lock.current = false; }
  };
  const save = async () => {
    if (lock.current || phase === 'saved' || phase === 'unknown' || phase === 'conflict') return;
    if (pending.has(identity)) { setPhase('unknown'); return; }
    operation.current = `members:${crypto.randomUUID()}`;
    pending.set(identity, { operationId: operation.current, phase: 'pending', view, target: [...target] });
    lock.current = true; setPhase('saving');
    try {
      const receipt = receiptValue(await (submit ? submit(operation.current) : actions.remote().editMembers(key, {
        operationId: operation.current, expectedRevision: view.group.revision,
        expectedMembershipRevision: view.group.membershipRevision, members: [...target],
        ...(rosterAddedMembers(view, target).length ? { historyConfirmed: true as const } : {}),
      })));
      if (receipt.status === 'not-found') { markNotFound(); return; }
      if (receipt.status !== 'saved') { setPhase('unknown'); return; }
      await markSaved();
    } catch (cause) {
      if (hasOperationCode(cause, 'conflict')) {
        pending.delete(identity); operation.current = undefined; setPhase('conflict');
        try { setLatest(unwrapGroup(await actions.remote().view(key, {}))); } catch { /* Keep the reviewed draft. */ }
      } else if ((['member-limit', 'unsupported', 'recovery-needed', 'not-found', 'invalid', 'approval-denied', 'unavailable'] as const).some(code => hasOperationCode(cause, code))) {
        pending.delete(identity); operation.current = undefined; setFailureKey(hasOperationCode(cause, 'unavailable') ? 'groups.roster.failedUnavailable' : hasOperationCode(cause, 'approval-denied') ? 'groups.roster.failedApproval' : hasOperationCode(cause, 'member-limit') ? 'groups.roster.failedLimit' : hasOperationCode(cause, 'not-found') ? 'groups.roster.failedMissing' : 'groups.roster.failed'); setPhase('failed');
      } else {
        try {
          const receipt = receiptValue(await actions.remote().getMemberEditResult(key, operation.current));
          if (receipt.status === 'saved') { await markSaved(); }
          else if (receipt.status === 'not-found') { markNotFound(); }
          else setPhase('unknown');
        } catch { setPhase('unknown'); }
      }
    } finally { lock.current = false; }
  };
  return { phase, latest, failureKey, refreshFailed, save, check, refresh, loadLatest, reset: () => { operation.current = undefined; setPhase('idle'); setLatest(undefined); } };
}

export function RosterSaveNotice({ mutation, t }: { mutation: ReturnType<typeof useRosterSave> } & Localized) {
  return <>
    {mutation.phase === 'saving' && <p role="status">{t('groups.roster.saving')}</p>}
    {mutation.phase === 'saved' && mutation.refreshFailed && <p role="status">{t('groups.roster.savedRefreshFailed')} <Button variant="ghost" onClick={() => void mutation.refresh()}>{t('bots.refresh')}</Button></p>}
    {mutation.phase === 'unknown' && <p role="alert">{t('groups.roster.unknown')} <Button variant="ghost" onClick={() => void mutation.check()}>{t('groups.roster.checkReceipt')}</Button></p>}
    {mutation.phase === 'conflict' && <p role="alert">{t('groups.roster.conflict')} {!mutation.latest && <Button variant="ghost" onClick={() => void mutation.loadLatest()}>{t('bots.refresh')}</Button>}</p>}
    {mutation.phase === 'failed' && <p role="alert">{t(mutation.failureKey as 'groups.roster.failed')}</p>}
  </>;
}

export function RosterManagement({ initial, actions, bots, onClose, t }: {
  initial: GroupView; actions: GroupActions; bots: readonly BotRecord[]; onClose(): void;
} & Localized) {
  const persisted = actions.memberEdits?.get(JSON.stringify(groupKey(initial.group)));
  const [baseline, setBaseline] = useState(persisted?.view ?? initial);
  const [target, setTarget] = useState(() => persisted?.target ?? rosterMembers(initial).map(member => member.bot));
  const navigation = useSettingsNavigation(t);
  const [query, setQuery] = useState('');
  const mutation = useRosterSave(actions, baseline, target, onClose);
  const current = rosterMembers(baseline);
  const limit = baseline.memberLimit ?? GROUP_MEMBER_LIMIT;
  const added = rosterAddedMembers(baseline, target);
  const removed = current.filter(member => !target.some(key => sameBot(key, member.bot)));
  const changed = JSON.stringify(current.map(member => member.bot)) !== JSON.stringify(target);
  const dirty = changed && !['saved', 'unknown'].includes(mutation.phase);
  useLayoutEffect(() => {
    navigation.registry.set('roster-local', dirty);
    return () => navigation.registry.set('roster-local', false);
  }, [navigation.registry, dirty]);
  const blocked = memberEditingReason(baseline);
  const locked = mutation.phase === 'saving' || mutation.phase === 'saved' || mutation.phase === 'unknown' || mutation.phase === 'conflict';
  const valid = target.length >= 2 && (current.length > limit ? target.length < current.length && !added.length : target.length <= limit);
  const allKeys = [...current.map(member => member.bot), ...target.filter(key => !current.some(member => sameBot(member.bot, key)))];
  const name = (key: BotKey) => {
    const label = rosterMemberName(baseline, key, bots);
    return allKeys.some(other => !sameBot(other, key) && rosterMemberName(baseline, other, bots) === label) ? `${label} · ${key.botId}` : label;
  };
  const change = (next: BotKey[]) => { setTarget(next); if (mutation.phase === 'failed') mutation.reset(); };
  const candidates = bots.filter(bot => (actions.canAddBot?.(bot) ?? true) && !allKeys.some(key => key.botId === bot.id && key.botCreatedAt === bot.createdAt) &&
    `${bot.name} ${bot.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const latest = mutation.latest;
  useStyleSheet('roster', css);
  const leave = () => navigation.leave(onClose);
  return <SettingsDrafts.Provider value={navigation.registry}><Modal title={t('groups.roster.manage')} description={baseline.group.name} busy={mutation.phase === 'saving'} onClose={leave} t={t}>
    <div className={styles.body} data-roster-management="">
      <div className={styles.heading}><strong>{t('groups.memberCapacity', { count: target.length, limit })}</strong><span>{t('groups.roster.minimum')}</span></div>
      {blocked && <p role="status">{t(blocked)}</p>}
      {current.length > limit && <p role="status">{t('groups.memberLimitLegacy', { count: target.length, limit })}</p>}
      <ul className={styles.list} aria-label={t('groups.members')}>
        {allKeys.map(key => {
          const member = current.find(member => sameBot(member.bot, key));
          const bot = bots.find(bot => bot.id === key.botId && bot.createdAt === key.botCreatedAt);
          const selected = target.some(peer => sameBot(peer, key));
          const pendingAdd = !member;
          const speaker = baseline.messages.find(message => message.speaker && sameBot(message.speaker.bot, key))?.speaker;
          const unavailable = !bot || (member && baseline.unavailableMemberIds.includes(member.id));
          const index = target.findIndex(peer => sameBot(peer, key));
          return <li key={`${key.botId}:${key.botCreatedAt}`} className={styles.row} data-roster-member={key.botId}>
            <BotAvatar size={32} bot={bot ?? { id: key.botId, avatar: speaker?.avatar, avatarColor: speaker?.avatarColor, avatarVariant: speaker?.avatarVariant }} />
            <div className={styles.identity}><strong>{name(key)}</strong><span>{pendingAdd ? t('groups.roster.pendingAdd') : !selected ? t('groups.roster.pendingRemove') : unavailable ? t('groups.unavailable') : !member.enabled ? t('navigation.memberDisabled') : t('groups.ready')}</span></div>
            <div className={styles.rowActions}>
              {selected && <Button variant="ghost" size="sm" disabled={locked || !!blocked || index === 0} aria-label={`${t('groups.moveUp')} ${name(key)}`} onClick={() => {
                const next = [...target], previous = next[index - 1], item = next[index];
                if (!previous || !item) return;
                [next[index - 1], next[index]] = [item, previous]; change(next);
              }}>{t('groups.moveUp')}</Button>}
              <Button variant="ghost" size="sm" disabled={locked || !!blocked} aria-label={`${t(pendingAdd || !selected ? 'groups.roster.undo' : 'groups.roster.remove')} ${name(key)}`}
                onClick={() => change(selected ? target.filter(peer => !sameBot(peer, key)) : [...target, key])}>{t(pendingAdd || !selected ? 'groups.roster.undo' : 'groups.roster.remove')}</Button>
            </div>
          </li>;
        })}
      </ul>
      <section aria-label={t('groups.addMembers')}>
        <h3>{t('groups.addMembers')}</h3>
        <label className={styles.search}>{t('groups.roster.search')}<input value={query} disabled={locked || !!blocked} onChange={event => setQuery(event.target.value)} /></label>
        <ul className={styles.list}>{candidates.map(bot => <li className={styles.row} key={`${bot.id}:${bot.createdAt}`}>
          <BotAvatar bot={bot} size={32} /><div className={styles.identity}><strong>{bot.name}</strong>{bots.some(other => other.id !== bot.id && other.name === bot.name) && <span>{bot.id}</span>}</div>
          <Button size="sm" variant="ghost" disabled={locked || !!blocked || target.length >= limit || current.length > limit} onClick={() => change([...target, { botId: bot.id, botCreatedAt: bot.createdAt }])}>{t('groups.roster.add')}</Button>
        </li>)}</ul>
        {!candidates.length && <p>{t('groups.roster.noCandidates')}</p>}
      </section>
      {mutation.phase === 'conflict' && latest && <section data-roster-conflict=""><h3>{t('groups.roster.currentRoster')}</h3><p>{formatList(rosterMembers(latest).map(member => rosterMemberName(latest, member.bot, bots)), t('activity.locale'))}</p>
        <MemberChangeReview view={latest} target={target} bots={bots} t={t} />
        <Button onClick={() => { if (latest) { setBaseline(latest); mutation.reset(); } }}>{t('groups.roster.reviewLatest')}</Button></section>}
      <RosterSaveNotice mutation={mutation} t={t} />
    </div>
    <footer className={`${dialogStyles.dialogFooter} ${styles.footer}`}>
      <div className={styles.summary}>{changed ? <><strong>{t('groups.roster.changeCount', { added: added.length, removed: removed.length })}</strong><MemberChangeReview view={baseline} target={target} bots={bots} t={t} /></> : <p>{t('groups.roster.noChanges')}</p>}
        {!valid && <p role="status">{t('groups.roster.invalidCount', { limit })}</p>}</div>
      <div className={styles.footerActions}><Button disabled={mutation.phase === 'saving'} onClick={leave}>{t('actions.cancel')}</Button>
        <Button variant="primary" disabled={locked || !!blocked || !changed || !valid} onClick={() => void mutation.save()}>{t(added.length ? 'groups.roster.confirmAddSave' : 'integrations.save')}</Button></div>
    </footer>
  </Modal>{navigation.confirmation}</SettingsDrafts.Provider>;
}
