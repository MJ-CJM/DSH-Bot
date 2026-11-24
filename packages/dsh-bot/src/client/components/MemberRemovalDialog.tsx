import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupMember, GroupView } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { groupKey } from '../../shared/groups.js';
import css from '../styles/roster.module.css?inline';
import { sameBot } from '../../shared/identity.js';
import type { GroupActions } from '../groups-state.js';
import { latestMemberDelivery } from '../group-management.js';
import { Modal } from './Modal.js';
import { MemberChangeReview, memberEditingReason, rosterMemberName, rosterMembers, RosterSaveNotice, useRosterSave } from './RosterManagement.js';
import styles from '../styles/bots.module.css';

/** Direct member action has exactly one confirmation and one mutation. */
export function MemberRemovalDialog({ view, member, bots, actions, onClose, t }: {
  view: GroupView; member: GroupMember; bots: readonly BotRecord[]; actions: GroupActions; onClose(): void;
} & PropsLocale<'dsh-bot'>) {
  const persisted = actions.memberEdits?.get(JSON.stringify(groupKey(view.group)));
  const [baseline, setBaseline] = useState(persisted?.view ?? view);
  const [target, setTarget] = useState(() => persisted?.target ?? rosterMembers(view).filter(row => !sameBot(row.bot, member.bot)).map(row => row.bot));
  const mutation = useRosterSave(actions, baseline, target, onClose);
  const reason = memberEditingReason(baseline);
  const latest = mutation.latest;
  const exists = rosterMembers(baseline).some(row => sameBot(row.bot, member.bot));
  const delivery = latestMemberDelivery(baseline, member.id, row => sameBot(row.bot, member.bot));
  const running = delivery && ['pending', 'starting', 'running'].includes(delivery.state);
  return <Modal title={t('groups.roster.removeTitle', { name: rosterMemberName(baseline, member.bot, bots) })} busy={mutation.phase === 'saving'} onClose={onClose} t={t}>
    <style>{css}</style>
    <div className={styles.editorBody} data-member-removal="">
      <p>{baseline.group.name}</p>
      {!exists && <p role="status">{t('groups.roster.alreadyRemoved')}</p>}
      <MemberChangeReview view={baseline} target={target} bots={bots} t={t} />
      {running && <p role="status">{t('groups.roster.stopRemoved', { name: rosterMemberName(baseline, member.bot, bots) })}</p>}
      {reason && <p role="status">{t(reason)}</p>}
      {target.length < 2 && <p role="status">{t('groups.roster.minimum')}</p>}
      <RosterSaveNotice mutation={mutation} t={t} />
      {mutation.phase === 'conflict' && latest && <section data-roster-conflict=""><h3>{t('groups.roster.currentRoster')}</h3>
        <p>{rosterMembers(latest).map(row => rosterMemberName(latest, row.bot, bots)).join('、')}</p>
        <Button onClick={() => {
          if (!latest) return;
          setBaseline(latest);
          setTarget(rosterMembers(latest).filter(row => !sameBot(row.bot, member.bot)).map(row => row.bot));
          mutation.reset();
        }}>{t('groups.roster.reviewLatest')}</Button></section>}
    </div>
    <footer className={styles.dialogFooter}><Button disabled={mutation.phase === 'saving'} onClick={onClose}>{t('actions.cancel')}</Button>
      <Button className={styles.dangerButton} disabled={!!reason || !exists || target.length < 2 || !['idle', 'failed'].includes(mutation.phase)} onClick={() => void mutation.save()}>{t('groups.roster.remove')}</Button></footer>
  </Modal>;
}
