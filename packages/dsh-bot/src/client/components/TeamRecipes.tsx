import { useEffect, useLayoutEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { groupKey, type GroupView } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { GROUP_MEMBER_LIMIT } from '../../shared/group-limits.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import { teamRecipeInputSchema, type TeamRecipe, type TeamPreview } from '../../shared/team-recipes.js';
import { unwrapGroup, type GroupActions } from '../groups-state.js';
import { useStyleSheet } from '../use-style-sheet.js';
import styles from '../styles/groups.module.css';
import rosterCss from '../styles/roster.module.css?inline';
import { SettingsDrafts, useSettingsNavigation } from './SettingsNavigation.js';
import { MemberChangeReview, RosterSaveNotice, rosterAddedMembers, rosterMemberName, rosterMembers, useRosterSave } from './RosterManagement.js';

function parseRecipe(input: unknown): TeamRecipe {
  if (typeof input === 'object' && input !== null && 'roles' in input && Array.isArray(input.roles) && input.roles.length > GROUP_MEMBER_LIMIT)
    throw Object.assign(new Error('Team member limit exceeded'), { code: 'dsh-bot/member-limit' });
  return teamRecipeInputSchema.parse(input);
}

export function TeamRecipes({ view, actions, bots = [], onClose, onSaved, t }: {
  view: GroupView; bots?: readonly BotRecord[]; actions: GroupActions; onClose(): void; onSaved(): Promise<unknown>;
} & PropsLocale<'dsh-bot'>) {
  const groupId = view.group.id, groupCreatedAt = view.group.createdAt, defaultName = view.group.name.slice(0, 64);
  const pending = actions.memberEdits?.get(JSON.stringify(groupKey(view.group)));
  const [baseline, setBaseline] = useState(pending?.view ?? view);
  const navigation = useSettingsNavigation(t);
  const limit = baseline.memberLimit ?? GROUP_MEMBER_LIMIT;
  const [saved, setSaved] = useState<Array<{ id: string; recipe: TeamRecipe }>>([]);
  const [name, setName] = useState(defaultName);
  const [preview, setPreview] = useState<TeamPreview>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(true), [error, setError] = useState<'failed' | 'member-limit'>();
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = unwrapGroup(await actions.remote().teamList());
        if (alive) setSaved(list);
        const recipe = unwrapGroup(await actions.remote().teamCapture({ groupId, groupCreatedAt }, defaultName));
        const next = unwrapGroup(await actions.remote().teamPreview(recipe, []));
        if (alive) { setName(defaultName); setSaved(list); setPreview(next); setDraft(JSON.stringify(recipe, null, 2)); }
      } catch (cause) { if (alive) setError(hasOperationCode(cause, 'member-limit') ? 'member-limit' : 'failed'); }
      finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; };
  }, [actions, groupId, groupCreatedAt, defaultName]);

  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await work(); } catch (cause) { setError(hasOperationCode(cause, 'member-limit') ? 'member-limit' : 'failed'); } finally { setBusy(false); }
  };
  const show = async (recipe: TeamRecipe) => {
    parseRecipe(recipe);
    setPreview(unwrapGroup(await actions.remote().teamPreview(recipe, [])));
    setName(recipe.name);
    setDraft(JSON.stringify(recipe, null, 2));
  };
  const selected = preview?.roles.flatMap(role => role.bot ? [{ roleId: role.roleId, bot: role.bot }] : []) ?? [];
  const target = selected.map(row => row.bot);
  const added = rosterAddedMembers(baseline, target);
  const mutation = useRosterSave(actions, baseline, target, onClose, async operationId => {
    if (!preview) throw new Error('Recipe preview unavailable');
    return actions.remote().teamApplyMembers(groupKey(baseline.group), preview.recipe, selected,
      baseline.group.revision, baseline.group.membershipRevision,
      { operationId, ...(added.length ? { historyConfirmed: true as const } : {}) });
  }, onSaved);
  const applying = mutation.phase !== 'idle' && mutation.phase !== 'failed';
  const originalMembers = rosterMembers(baseline);
  const memberDraft = !!preview && JSON.stringify(originalMembers.map(member => member.bot)) !== JSON.stringify(target) && !['saved', 'unknown'].includes(mutation.phase);
  useLayoutEffect(() => {
    navigation.registry.set('recipe-members', memberDraft);
    return () => navigation.registry.set('recipe-members', false);
  }, [navigation.registry, memberDraft]);
  const leave = () => navigation.leave(onClose);
  const reviewTarget = pending && applying ? pending.target : target;
  const invalidLegacyEdit = originalMembers.length > limit && (selected.length >= originalMembers.length || selected.some(row => !originalMembers.some(member => member.bot.botId === row.bot.botId && member.bot.botCreatedAt === row.bot.botCreatedAt)));
  const exportRecipe = () => {
    if (!preview) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(preview.recipe, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'dsh-bot-team.json'; link.click();
    URL.revokeObjectURL(url);
  };
  useStyleSheet('roster', rosterCss);
  return <SettingsDrafts.Provider value={navigation.registry}><section className={`${styles.settingsOverview} ${styles.teamRecipes}`} role="dialog" aria-label={t('teams.title')} data-team-recipes="">
    <h3>{t('teams.title')}</h3>
    <p>{t('teams.safe')}</p>
    <p>{t('teams.memberLimit', { limit })}</p>
    {error && <p role="alert">{t(error === 'member-limit' ? 'groups.memberLimitFailed' : 'teams.failed', { limit })}</p>}
    <label>{t('teams.name')} <input value={name} maxLength={64} disabled={busy || applying} onChange={event => { const value = event.currentTarget.value; setName(value); setDraft(current => { try { return JSON.stringify({ ...JSON.parse(current), name: value.trim() }, null, 2); } catch { return current; } }); setPreview(current => current ? { ...current, recipe: { ...current.recipe, name: value.trim() } } : current); }} /></label>
    <Button disabled={busy || applying || !name.trim()} onClick={() => void run(async () => {
      const recipe = unwrapGroup(await actions.remote().teamCapture(groupKey(view.group), name));
      await show(recipe);
    })}>{t('teams.capture')}</Button>
    <details data-team-advanced=""><summary>{t('simple.recipeAdvanced')}</summary>
    <label>{t('teams.json')}<textarea value={draft} maxLength={65536} disabled={busy || applying} onChange={event => { setDraft(event.currentTarget.value); setPreview(undefined); }} /></label>
    <label>{t('teams.importFile')} <input type="file" accept="application/json,.json" disabled={busy || applying} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) void run(async () => {
        if (file.size > 65536) throw new Error('Recipe too large');
        await show(parseRecipe(JSON.parse(await file.text())));
      });
    }} /></label>
    <Button disabled={busy || applying || !draft.trim()} onClick={() => void run(() => show(parseRecipe(JSON.parse(draft))))}>{t('teams.preview')}</Button></details>
    {preview && <div data-team-preview="">
      <p>{t('teams.version', { version: preview.recipe.version })} · {t(`groups.${preview.recipe.mode}`)}</p>
      <p>{t('teams.mappingHint')}</p>
      {preview.roles.map(row => {
        const role = preview.recipe.roles.find(role => role.id === row.roleId);
        if (!role) return null;
        return <label key={row.roleId}>{role.role} · {role.template} · {t(`teams.match.${row.match}`)}
          {!row.capabilityMatch && <span role="status"> {t('teams.capabilityMismatch')}</span>}
          <select aria-label={role.role} value={row.bot ? JSON.stringify(row.bot) : ''} disabled={busy || applying} onChange={event => {
            const value = event.currentTarget.value;
            if (!value) return;
            void run(async () => setPreview(unwrapGroup(await actions.remote().teamPreview(preview.recipe,
              [...selected.filter(item => item.roleId !== row.roleId), { roleId: row.roleId, bot: JSON.parse(value) }]))));
          }}>
            <option value="">{t('teams.unmapped')}</option>
            {row.candidates.map(candidate => <option key={candidate.bot.botId} value={JSON.stringify(candidate.bot)}>
              {candidate.name} · {candidate.bot.botId} · {candidate.template}
            </option>)}
          </select>
        </label>;
      })}
      <Button disabled={busy || applying || !preview.recipe.name.trim()} onClick={() => void run(async () => {
        const result = unwrapGroup(await actions.remote().teamSave(preview.recipe));
        setSaved(current => [result, ...current.filter(row => row.id !== result.id)]);
      })}>{t('teams.save')}</Button>
      <Button disabled={busy || applying} onClick={exportRecipe}>{t('teams.export')}</Button>
      <MemberChangeReview view={baseline} target={reviewTarget} bots={bots} t={t} />
      <Button disabled={busy || applying || invalidLegacyEdit || preview.recipe.roles.length > limit || baseline.group.archived || !!baseline.group.supergroup || baseline.group.state !== 'ready' || selected.length !== preview.roles.length || new Set(selected.map(row => JSON.stringify(row.bot))).size !== selected.length} onClick={() => void mutation.save()}>{t(added.length ? 'groups.roster.confirmAddSave' : 'teams.apply')}</Button>
    </div>}
    {saved.length > 0 && <details><summary>{t('simple.savedTeams')}</summary>
    <ul>{saved.map(row => <li key={row.id}>
      <Button disabled={busy || applying} onClick={() => void run(() => show(row.recipe))}>{row.recipe.name}</Button>
      <Button disabled={busy || applying} onClick={() => void run(async () => {
        unwrapGroup(await actions.remote().teamRemove(row.id));
        setSaved(current => current.filter(item => item.id !== row.id));
      })}>{t('teams.remove')}</Button>
    </li>)}</ul>
    </details>}
    <RosterSaveNotice mutation={mutation} t={t} />
    {mutation.phase === 'conflict' && mutation.latest && <section data-team-roster-conflict="">
      <h4>{t('groups.roster.currentRoster')}</h4>
      <p>{rosterMembers(mutation.latest).map(member => rosterMemberName(mutation.latest!, member.bot, bots)).join('、')}</p>
      <MemberChangeReview view={mutation.latest} target={target} bots={bots} t={t} />
      <Button onClick={() => { setBaseline(mutation.latest!); mutation.reset(); }}>{t('groups.roster.reviewLatest')}</Button>
    </section>}
    <Button disabled={busy || mutation.phase === 'saving'} onClick={leave}>{t('groups.close')}</Button>
  </section>{navigation.confirmation}</SettingsDrafts.Provider>;
}
