import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupMethods } from '../../shared/groups-contract.js';
import { groupKey, type GroupRecord } from '../../shared/groups.js';
import type { BotKey } from '../../shared/identity.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import type { BotRecord } from '../../shared/schema.js';
import { type GroupActions, unwrapGroup } from '../groups-state.js';
import styles from '../styles/groups.module.css';

type ExportSettings = Extract<Awaited<ReturnType<GroupMethods['getExportApprovalSettings']>>, { ok: true }>['value'];
const sameBot = (a: BotKey, b: BotKey) => a.botId === b.botId && a.botCreatedAt === b.botCreatedAt;

export function GroupExportSettings({ group, actions, bots, onSaved, t }: {
  group: GroupRecord;
  actions: GroupActions;
  bots: readonly BotRecord[];
  onSaved(): Promise<unknown>;
} & PropsLocale<'dsh-bot'>) {
  const [settings, setSettings] = useState<ExportSettings>();
  const [selected, setSelected] = useState<{ bot: BotKey; settings: ExportSettings }>();
  const [problem, setProblem] = useState<'load' | 'changed' | 'save'>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const confirmation = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>();
  const { id, createdAt, revision, membershipRevision } = group;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revisions and manual refresh invalidate the remote reader snapshot.
  useEffect(() => {
    let current = true;
    setSettings(undefined);
    void actions.remote().getExportApprovalSettings({ groupId: id, groupCreatedAt: createdAt }).then(unwrapGroup).then(value => {
      if (current) setSettings(value);
    }).catch(() => {
      if (current) setProblem(value => value ?? 'load');
    });
    return () => { current = false; };
  }, [actions, id, createdAt, revision, membershipRevision, attempt]);
  const nameOf = (bot: BotKey) => bots.find(row => row.id === bot.botId && row.createdAt === bot.botCreatedAt)?.name
    ?? settings?.readers.find(row => sameBot(row.bot, bot))?.name ?? bot.botId;
  const refresh = () => { setProblem(undefined); setAttempt(value => value + 1); };
  const save = async (bot: BotKey, enabled: boolean, snapshot: ExportSettings) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem(undefined);
    setSelected(undefined);
    try {
      unwrapGroup(await actions.remote().setExportApproval(groupKey(group), bot, enabled, snapshot.groupRevision, snapshot.membershipRevision));
    } catch (error) {
      setProblem(hasOperationCode(error, 'conflict') ? 'changed' : 'save');
    } finally {
      setAttempt(value => value + 1);
      await Promise.allSettled([onSaved(), actions.catalog.refresh(), actions.messageView(groupKey(group)).refresh()]);
      lock.current = false;
      setBusy(false);
    }
  };
  const confirm = selected && settings && selected.settings.groupRevision === settings.groupRevision &&
    selected.settings.membershipRevision === settings.membershipRevision && settings.canEnable ? selected : undefined;
  useEffect(() => { if (confirm) confirmation.current?.focus(); }, [confirm]);
  const members = settings ? [...settings.eligibleBots, ...settings.enabledBots.filter(bot =>
    !settings.eligibleBots.some(member => sameBot(bot, member)))] : [];
  return <section className={styles.exportPolicySettings} aria-label={t('groups.export.policies')} data-group-export-settings={id}>
    <h4>{t('groups.export.policies')}</h4>
    <p>{t('groups.export.policyFutureOnly')}</p>
    {problem && <p role="alert">{t(problem === 'changed' ? 'groups.export.policyChanged' : problem === 'save' ? 'groups.export.policySaveFailed' : 'groups.export.policyLoadFailed')} <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={refresh}>{t('bots.refresh')}</Button></p>}
    {!settings && !problem && <p role="status">{t('groups.loading')}</p>}
    {settings && <>
      {!settings.canEnable && <p role="status">{t('groups.export.policyUnavailable')}</p>}
      {settings.canEnable && members.length === 0 && <p>{t('groups.export.policyEmpty')}</p>}
      <ul className={styles.exportPolicyList}>
        {members.map(bot => {
          const enabled = settings.enabledBots.some(row => sameBot(row, bot));
          return <li key={JSON.stringify(bot)} data-export-policy-bot={bot.botId}>
            <span className={styles.exportPolicyMember}><strong>{nameOf(bot)}</strong><small>{t(enabled ? 'groups.export.enabled' : 'groups.export.policyOff')}</small></span>
            <Button type="button" variant="ghost" size="sm" data-export-policy-action="" disabled={busy || !enabled && !settings.canEnable}
              onClick={event => {
                if (enabled) void save(bot, false, settings);
                else { trigger.current = event.currentTarget; setSelected({ bot, settings }); }
              }}>
              {t(enabled ? 'groups.export.disable' : 'groups.export.policyEnable')}
            </Button>
          </li>;
        })}
      </ul>
    </>}
    {confirm && <fieldset ref={confirmation} tabIndex={-1} className={styles.exportPolicyConfirm} aria-label={t('groups.export.policyConfirm', { bot: nameOf(confirm.bot) })}>
      <p>{t('groups.export.policyReaders', { bot: nameOf(confirm.bot), members: confirm.settings.readers.map(row => row.name).join(t('groups.export.policyReaderSeparator')) })}</p>
      <Button type="button" size="sm" data-export-policy-confirm="" disabled={busy}
        onClick={() => { void save(confirm.bot, true, confirm.settings); }}>{t('groups.export.policyConfirm', { bot: nameOf(confirm.bot) })}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setSelected(undefined); trigger.current?.focus(); }}>{t('groups.export.policyCancel')}</Button>
    </fieldset>}
  </section>;
}
