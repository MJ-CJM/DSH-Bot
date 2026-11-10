import {ResponsibilityWorkspace} from "../proactive/ResponsibilityWorkspace.js";
import {GovernancePanel} from "../proactive/GovernancePanel.js";
import {FeedbackWorkspace} from "../proactive/FeedbackWorkspace.js";
import { SuggestionPanel } from '../proactive/SuggestionPanel.js';
import { FollowUpPanel } from '../proactive/FollowUpPanel.js';
import { followUpSessionTarget, useFollowUpPolicyRevision } from '../proactive/follow-up-state.js';
import { ProactiveSetup } from '../proactive/ProactiveSetup.js';
import { Button, SegmentedTabs, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CapabilitiesPanel } from '../components/CapabilitiesPanel.js';
import { MessageOverviewPanel } from '../components/MessageOverview.js';
import { BackgroundTasksPanel } from '../components/BackgroundTasksPanel.js';
import { RoutinePanel } from '../components/RoutinePanel.js';
import { BotAvatar } from '../components/BotAvatar.js';
import { BotEditor } from '../components/BotEditor.js';
import { ManagementPanel } from '../components/ManagementPanel.js';
import { ConnectorsPanel } from '../components/ConnectorsPanel.js';
import { NotificationsPanel } from '../components/NotificationsPanel.js';
import { RetainedPanel } from '../components/RetainedPanel.js';
import { SettingsBotContext } from '../components/SettingsBotContext.js';
import { SettingsDrafts, useSettingsNavigation } from '../components/SettingsNavigation.js';
import detailStyles from '../styles/detail.module.css';
import css from '../styles/detail.module.css?inline';
import type { BotsPageProps } from './bots-page-types.js';
import type { BotsPageModel } from './use-bots-page.js';
import { BotSessionHistory } from './BotSessionHistory.js';
import { MemoryTab } from './BotMemoryTab.js';
import { useProactiveWork } from '../proactive/work-state.js';
import workspaceStyles from '../proactive/workspace.module.css';

type Section = 'overview' | 'work' | 'memory' | 'settings' | 'history';
type SettingsSection = 'profile' | 'capabilities' | 'connectors' | 'notifications';
/** One owner-bound page; long settings never grow the quick-create modal. */
export function BotsTab({ page, model }: { page: BotsPageProps; model: BotsPageModel }) {
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [saving, setSaving] = useState(false);
  const destination = model.detailDestination;
  const requestId = destination?.requestId;
  const destinationSection = destination?.section;
  const targetKind = destination?.target?.kind;
  const onTargetReached = model.onDetailTargetReached;
  const otherWork = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<Section>(destinationSection ?? 'overview');
  useLayoutEffect(() => {
    if (requestId !== undefined) setPanel(destinationSection ?? 'overview');
  }, [requestId, destinationSection]);
  useEffect(() => {
    if (panel !== 'work' || targetKind !== 'other-work' || requestId === undefined || !otherWork.current) return;
    otherWork.current.focus({ preventScroll: true });
    otherWork.current.scrollIntoView?.({ block: 'nearest' });
    onTargetReached(requestId);
  }, [panel, targetKind, requestId, onTargetReached]);
  const [settingsPanel, setSettingsPanel] = useState<SettingsSection>('profile');
  const [editing, setEditing] = useState(false), [more, setMore] = useState(false);
  const uid = useId(), { t } = page, navigation = useSettingsNavigation(t);
  const { selected, showDetail, tab, busy } = model;
  if (tab === 'management' || !showDetail || !selected) return null;
  const bot = selected.bot, bots = [bot];
  const start = () => navigation.leave(() => { void model.navigate(signal => page.onStart(bot.id, signal), 'errors.start'); });
  const back = () => navigation.leave(model.returnFromDetail);
  const sections = ['overview', 'work', 'memory', 'settings', 'history'] as const;
  const settingsSections: SettingsSection[] = ['profile', ...(page.models ? ['capabilities' as const] : []), ...(page.integrations ? ['connectors' as const, 'notifications' as const] : [])];
  return <SettingsDrafts.Provider value={navigation.registry}>
    <SettingsBotContext.Provider value={{ bot, select: () => {} }}>
    <article className={detailStyles.page} data-bot-detail={bot.id} data-bot-identity={`${bot.id}:${bot.createdAt}`}>
      <style>{css}</style>
      <Button ref={model.backElement} variant="ghost" onClick={back} disabled={busy || saving}>{t('navigation.returnTo', { name: t(model.section === 'groups' ? 'groups.title' : model.section === 'recent' ? 'chat.recent' : 'navigation.myBots') })}</Button>
      <header className={detailStyles.header}>
        <BotAvatar bot={bot} size={48} />
        <div className={detailStyles.identity}><h1>{bot.name}</h1><p>{bot.description || t('persona.empty')}</p></div>
        <div className={detailStyles.actions}>
          <Button variant="primary" disabled={busy || model.navigating || !model.ready} onClick={start}>{t('chat.openChat')}</Button>
          <Menu open={more} onClose={() => setMore(false)} align="end"
            anchor={<Button variant="ghost" aria-haspopup="menu" aria-expanded={more} disabled={busy || saving} onClick={() => setMore(!more)}>{t('card.more')}</Button>}
            items={[{ id: 'duplicate', label: t('card.duplicate') }, { id: 'delete', label: t('actions.delete') }]}
            onSelect={id => { setMore(false); navigation.leave(() => model.open({ kind: id === 'delete' ? 'delete' : 'duplicate', bot })); }} />
        </div>
      </header>
      {selected.status?.preset.state !== 'ok' && <p role="status">{t(selected.status?.preset.state === 'broken' ? 'card.statusBroken' : selected.status?.preset.state === 'missing' ? 'card.statusMissing' : 'card.statusUnknown')} {selected.status?.preset.reason}</p>}
      <div className={detailStyles.tabs}><SegmentedTabs label={t('detail.navigation')} value={panel} onChange={setPanel}
        items={sections.map(value => ({ value, label: t(`detail.${value}`), id: `${uid}-${value}`, panelId: `${uid}-${value}-panel` })) as [import('@deepseek-ai/dsh-client-ui-primitives').SegmentedTab<Section>, ...import('@deepseek-ai/dsh-client-ui-primitives').SegmentedTab<Section>[]]} /></div>
      <RetainedPanel active={panel === 'overview'} id={`${uid}-overview-panel`} labelledBy={`${uid}-overview`}>
        {page.followUp && <div className={detailStyles.section}><FollowUpPanel source={page.followUp}
          subject={{ kind: 'bot', bot: { botId: bot.id, botCreatedAt: bot.createdAt } }} mode="summary" active={panel === 'overview'}
          onShowAll={() => { setPanel('work'); document.getElementById(`${uid}-work`)?.focus(); }} t={t} /></div>}
        <section data-bot-persona={bot.id} className={detailStyles.section}>
          <Button variant="ghost" onClick={() => { setPanel('settings'); setSettingsPanel('profile'); setEditing(true); model.cancelNavigation(); }}>{t('card.edit')}</Button>
          <h2>{t('persona.title')}</h2><p className={detailStyles.persona}>{bot.persona.prefix || t('persona.empty')}</p>
          {page.onEditPersona && <Button variant="ghost" disabled={busy || model.navigating || !model.ready} onClick={() => navigation.leave(() => { void model.navigate(async () => { await page.onEditPersona?.(bot); }, 'errors.start'); })}>{t('persona.edit')}</Button>}
          <dl className={detailStyles.facts}><dt>{t('manage.model')}</dt><dd>{bot.model ? `${bot.model.provider} / ${bot.model.model}` : t('capabilities.modelDefault')}</dd>
            <dt>{t('memory.title')}</dt><dd>{t(bot.memory.enabled ? 'detail.memoryEnabled' : 'memory.disabled')}</dd></dl>
          <details><summary>{t('detail.identity')}</summary><code>{bot.id}</code></details>
        </section>
      </RetainedPanel>
      <RetainedPanel active={panel === 'work'} id={`${uid}-work-panel`} labelledBy={`${uid}-work`}>
        <div className={detailStyles.section}><Button variant="ghost" disabled={busy || model.navigating || !model.ready} onClick={start}>{t('detail.createTask')}</Button></div>
        <BotWorkSection page={page} model={model} bot={bot} active={panel === 'work'}
          onSettings={setting => { setPanel('settings'); setSettingsPanel(setting); }}>
          <section ref={otherWork} data-bot-other-work="" tabIndex={-1} aria-label={t('botPanel.otherWork')}>
            {page.background && <BackgroundTasksPanel bot={bot} actions={page.background} t={t} />}
            {page.routines && <RoutinePanel actions={page.routines} bots={bots} botId={bot.id} onOpenSession={page.onOpenSession} t={t} />}
          </section>
          {panel === 'work' && page.messages && <MessageOverviewPanel botId={bot.id} actions={page.messages} onOpen={page.onOpenSession} t={t} />}
        </BotWorkSection>
      </RetainedPanel>
      <RetainedPanel active={panel === 'memory'} id={`${uid}-memory-panel`} labelledBy={`${uid}-memory`}>
        {page.management ? <ManagementPanel bots={bots} actions={page.management} createMemoryPanel={page.createMemoryPanel} active={panel === 'memory'} t={t} />
          : <MemoryTab bot={bot} create={page.createMemoryPanel} active={panel === 'memory'} t={t} />}
      </RetainedPanel>
      <RetainedPanel active={panel === 'settings'} id={`${uid}-settings-panel`} labelledBy={`${uid}-settings`}>
        <div className={detailStyles.settingsNav}>{settingsSections.map(key => <Button key={key} variant="ghost" aria-pressed={settingsPanel === key} onClick={() => setSettingsPanel(key)}>{t(`detail.${key}`)}</Button>)}</div>
        <RetainedPanel active={settingsPanel === 'profile'}>
          {editing ? <BotEditor key={`${bot.id}:${bot.createdAt}`} embedded bot={bot} avatarWarning={selected.status?.warnings?.includes('avatar/invalid')} models={page.models} busy={busy}
            onEnsureHome={page.onEnsureHome} onEnsureBotsWorkspace={page.onEnsureBotsWorkspace} onPickDirectory={page.onPickDirectory}
            onCancel={() => navigation.leave(() => setEditing(false))}
            onSave={async input => { setSaving(true); try { await page.onUpdate(bot.id, input); if (live.current) { setEditing(false); model.setToast({ text: t('bots.saveSuccess'), error: false }); } } finally { if (live.current) setSaving(false); } }} t={t} /> :
            <div className={detailStyles.section}><h2>{t('detail.profile')}</h2><p>{t('bots.newSessionsNotice')}</p><Button onClick={() => setEditing(true)}>{t('card.edit')}</Button></div>}
        </RetainedPanel>
        {page.models && <RetainedPanel active={settingsPanel === 'capabilities'}><CapabilitiesPanel expanded bot={bot} actions={page.models} t={t} /></RetainedPanel>}
        {page.integrations && <>
          <RetainedPanel active={settingsPanel === 'connectors'}><ConnectorsPanel actions={page.integrations} active={panel === 'settings' && settingsPanel === 'connectors'} bots={bots} onOpenSession={page.onOpenSession} t={t} /></RetainedPanel>
          <RetainedPanel active={settingsPanel === 'notifications'}><NotificationsPanel actions={page.integrations} bots={bots} onOpenSession={page.onOpenSession} t={t} /></RetainedPanel>
        </>}
      </RetainedPanel>
      <RetainedPanel active={panel === 'history'} id={`${uid}-history-panel`} labelledBy={`${uid}-history`}><BotSessionHistory page={page} model={model} /></RetainedPanel>
      {navigation.confirmation}
    </article>
    </SettingsBotContext.Provider>
  </SettingsDrafts.Provider>;
}

function BotWorkSection({ page, model, bot, active, onSettings, children }: {
  page: BotsPageProps;
  model: BotsPageModel;
  bot: NonNullable<BotsPageModel['selected']>['bot'];
  active: boolean;
  onSettings(section: SettingsSection): void;
  children: ReactNode;
}) {
  const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
  const { proactive, proactiveResponsibilities, proactiveGovernance, proactiveFeedback, followUp, onOpenFollowUpWork, t } = page;
  const continuationPolicy = useFollowUpPolicyRevision(followUp, { kind: 'bot', bot: owner }, active);
  const { snapshot, refresh } = useProactiveWork(page.proactiveWork, owner, active && !!proactive);
  const destination = model.detailDestination;
  return <>
    {followUp && <div className={detailStyles.section}><FollowUpPanel source={followUp} subject={{ kind: 'bot', bot: owner }}
      mode="detail" active={active} navigation={{
        canOpen: origin => origin.kind === 'work' ? !!onOpenFollowUpWork : !!followUpSessionTarget(origin),
        open: (origin, signal) => origin.kind === 'work'
          ? onOpenFollowUpWork?.(owner, origin.ticketId) : followUp.openSession(origin, signal),
      }}
      advanced={allowed => active && allowed && snapshot.status?.state === 'ready' && !snapshot.status.localFeedScope && proactive?.setup
        ? <ProactiveSetup setup={proactive.setup} refresh={refresh} t={t} /> : null} t={t} /></div>}
    {active && proactive && <SuggestionPanel actions={proactive} bot={bot} snapshot={snapshot} refresh={refresh} followUpControls={!!followUp}
      continuationPolicy={continuationPolicy}
      target={destination?.target?.kind === 'other-work' ? undefined : destination?.target} onTargetReached={() => {
        if (destination) model.onDetailTargetReached(destination.requestId);
      }} onOpen={page.onOpenSession} t={t} />}
    {children}
    {/* These independent reads can fill their panels after the work link is focused. */}
    {active && proactive && snapshot.status?.state !== 'disabled' && <div className={`${detailStyles.section} ${workspaceStyles.content}`}>
      {proactiveResponsibilities && <ResponsibilityWorkspace bot={bot} actions={proactiveResponsibilities}
        status={snapshot.status} refresh={refresh} loading={snapshot.loading} failed={!!snapshot.error} t={t} />}
      {proactiveGovernance && <GovernancePanel actions={proactiveGovernance} source={snapshot.status?.localFeedScope} refresh={refresh} t={t} />}
      {proactiveFeedback && <FeedbackWorkspace owner={owner} actions={proactiveFeedback} t={t}
        onSettings={setting => onSettings(setting === 'notifications' ? 'notifications' : setting === 'workspace' ? 'profile' : 'capabilities')} />}
    </div>}
  </>;
}
