import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots';
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import { createChangeStream } from '../change-stream.js';
import { createPollingCatalog } from '../state.js';
import type { BotCatalog } from '../state.js';
import type { GroupActions } from '../groups-state.js';
import type { ActivityCatalog } from '../activity-state.js';
import type { BotsPageInjected } from '../pages/BotsPage.js';
import type { ExecutionBridge } from '../group-execution.js';
import { supergroupViewSchema, type SupergroupWorkView } from '../../shared/supergroup.js';
import { groupKey } from '../../shared/groups.js';
import { Button, Menu, IconPlusOutlineRegular, IconSearchOutlineRegular, IconEllipsisOutlineRegular, IconSettingsOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconDataOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { BrandMark } from './BrandMark.js';
import { BotBrandGlyph } from '../components/BotBrandGlyph.js';
import { ModeSwitcher } from './ModeSwitcher.js';
import { stopGroupWork } from './stop-group.js';
import { BotModePresentation } from './presentation.js';
import { BotAvatar } from '../components/BotAvatar.js';
import { GroupAvatar } from '../components/GroupAvatar.js';
import { TaskSupportPanel } from '../task-support.js';
import { FollowUpPanel } from '../proactive/FollowUpPanel.js';
import { followUpSessionTarget } from '../proactive/follow-up-state.js';
import { GroupOverview, GroupMembersList } from '../components/GroupOverview.js';
import { BOT_PANEL_KIND } from '../components/BotRightPanel.js';
import { createModeLifecycle, type CommandModeService } from './lifecycle.js';
import { findObjectForSession, objectKey, projectObjects, readPreferences, sortObjects, splitObjectSections, hasDuplicateName, distinctDescription, type BotModeObject } from './objects.js';
import css from './style.module.css?inline';

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'dsh-bot-mode-details': { section?: DetailSection } }
}
interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
type Locale = PropsLocale<'dsh-bot'>;
type DetailSection = 'details' | 'materials' | 'members' | 'tasks' | 'settings';
interface NavigationState { query: string; sequence: number; selected?: string; failure: boolean }
export interface BotModeActions {
  settings(): Promise<{ enabled: boolean }>;
  configure(input: { enabled: boolean; expectedEnabled: boolean }): Promise<{ enabled: boolean }>;
  status: Source<{ state: 'off' | 'starting' | 'ready' | 'failed'; reason?: string }>;
}
interface Dependencies {
  bots: BotCatalog; groups: GroupActions; activity: ActivityCatalog; page: BotsPageInjected;
  executionBridge?: ExecutionBridge;
  start(id: string): Promise<void>;
  memory(bot: { id: string; createdAt: number }): void;
  settings: { settings(): Promise<{ enabled: boolean }>; configure(input: { enabled: boolean; expectedEnabled: boolean }): Promise<{ enabled: boolean }> };
}
function Identity({ object, objects, size = 38 }: { object: BotModeObject; objects: BotModeObject[]; size?: number }) {
  return object.bot ? <BotAvatar bot={object.bot} size={size} /> : <GroupAvatar size={size} members={object.group?.members.filter(row => row.enabled && row.removedAt === undefined)} bots={objects.flatMap(row => row.bot ? [row.bot] : [])} />;
}

/** Only UI preferences live in sessionStorage. Authoritative ownership, work,
 * messages and drafts stay with their original Host/native stores. */
export function registerBotMode(ctx: Context, dependencies: Dependencies): BotModeActions {
  const { bots, groups, activity, page } = dependencies;
  const t = ctx.locale.bind('dsh-bot');
  let storage: Storage | undefined;
  try { storage = window.sessionStorage; } catch { /* Optional window-local persistence. */ }
  const preferenceKey = 'dsh-bot.bot-mode.v1';
  const preferences = readPreferences(storage, preferenceKey);
  const save = () => { try { storage?.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* Optional persistence. */ } };
  let state: NavigationState = { query: '', sequence: 0, failure: false };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<NavigationState>) => {
    const keys = Object.keys(patch) as Array<keyof NavigationState>;
    if (keys.length && keys.every(key => state[key] === patch[key])) return;
    state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const source = { getSnapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const objects = () => projectObjects(bots.getSnapshot().entries, groups.catalog.getSnapshot().groups, activity.getSnapshot());
  let navigation = 0, live = true;
  const select = async (object: BotModeObject) => {
    const epoch = ++navigation; update({ failure: false });
    try {
      // Recheck full generation immediately before selecting a persistent object.
      const current = objects().find(row => row.key === object.key);
      if (!current) throw new Error('Object unavailable');
      if (current.bot) await dependencies.start(current.bot.id);
      else if (current.group) await groups.open(groupKey(current.group.group));
      if (!live || epoch !== navigation) return;
      preferences.selected = { kind: current.kind, id: current.id, createdAt: current.createdAt };
      preferences.read[current.key] = current.at; save(); update({ selected: current.key });
      if (!sidebarCollapsed && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 700px)').matches) ctx.layout.toggleSidebar();
    } catch { if (live && epoch === navigation) update({ failure: true }); }
  };
  const manage = (section: 'bots' | 'groups' = 'bots', create = false) => {
    if (page.pageNavigation?.open) page.pageNavigation.open(section, create ? section === 'bots' ? 'bot' : 'group' : undefined);
    else if (page.pageNavigation) { page.pageNavigation.section = section; if (create) page.pageNavigation.create = section === 'bots' ? 'bot' : 'group'; }
    ctx.layout.selectPanel('dsh-bot' as MainPanelId);
  };
  let sidebarCollapsed = true;
  const search = () => { if (sidebarCollapsed) ctx.layout.toggleSidebar?.(); update({ sequence: state.sequence + 1 }); };
  const workCatalog = createPollingCatalog<{ works: SupergroupWorkView[] }>(ctx, { works: [] as SupergroupWorkView[] }, async () => {
    const remote = ctx.get('remote.dshBotSupergroup'); if (!remote) throw new Error('Supergroup unavailable');
    const result = await remote.catalog({}); if (!result.ok) throw result.error;
    if (!Array.isArray(result.value)) throw new Error('Invalid work catalog');
    return { works: result.value.map((value: unknown) => supergroupViewSchema.parse(value)) };
  });
  const useObjects = () => {
    const botSnapshot = useSyncExternalStore(bots.subscribe, bots.getSnapshot);
    const groupSnapshot = useSyncExternalStore(groups.catalog.subscribe, groups.catalog.getSnapshot);
    const activitySnapshot = useSyncExternalStore(activity.subscribe, activity.getSnapshot);
    const workSnapshot = useSyncExternalStore(workCatalog.subscribe, workCatalog.getSnapshot);
    const rows = useMemo(() => projectObjects(botSnapshot.entries, groupSnapshot.groups, activitySnapshot).map(object => {
      if (!object.group) return object;
      const work = workSnapshot.works.find(row => row.work.group?.groupId === object.id && row.work.group.groupCreatedAt === object.createdAt);
      const latest = work?.group?.messages.at(-1);
      return { ...object, goal: work?.group?.messages.find(message => message.authorKind === 'user')?.text, workState: work?.work.state, at: Math.max(object.at, work?.work.updatedAt ?? 0), ended: work ? ['completed', 'partial', 'cancelled'].includes(work.work.state) : false, preview: latest?.text ? [...latest.text].slice(0, 120).join('') : '' };
    }), [botSnapshot.entries, groupSnapshot.groups, activitySnapshot, workSnapshot.works]);
    return { rows,
      ready: botSnapshot.loaded && groupSnapshot.loaded, failed: Boolean(botSnapshot.error || groupSnapshot.error) };
  };
  const describe = (object: BotModeObject, rows: BotModeObject[]) => {
    if (hasDuplicateName(object, rows)) return distinctDescription(object, rows) ?? t('botMode.createdIdentity', {
      date: new Date(object.createdAt).toLocaleString(t('activity.locale')), id: object.id,
    });
    return object.bot?.description || (object.group ? t('navigation.memberCount', { count: object.group.members.filter(row => row.enabled && row.removedAt === undefined).length }) : '');
  };
  const refresh = () => { void Promise.allSettled([bots.refresh(), groups.catalog.refresh(), activity.refresh(), workCatalog.refresh()]); };
  function ContactRow({ object, rows, selected }: { object: BotModeObject; rows: BotModeObject[]; selected?: string }) {
    const [menu, setMenu] = useState(false);
    const pinned = preferences.pinned.includes(object.key);
    const duplicate = hasDuplicateName(object, rows);
    const subtitle = describe(object, rows);
    const blocked = Boolean(object.group?.running || (object.group?.group.supergroup && !object.ended));
    return <div className="dsh-bot-mode-row" data-bot-mode-row={object.key} data-bot-mode-kind={object.kind} data-bot-mode-pinned={pinned ? '' : undefined}>
      <button className="dsh-bot-mode-contact" type="button" title={duplicate ? `${object.name} · ${subtitle}` : object.name}
        aria-label={duplicate ? `${object.name} · ${subtitle}` : object.name} aria-current={selected === object.key ? 'page' : undefined} onClick={() => { void select(object); }}>
        <Identity object={object} objects={rows} /><span className="dsh-bot-mode-label">
          <span className="dsh-bot-mode-contact-top"><strong>{object.name}</strong>{object.hasActivity && <time dateTime={new Date(object.at).toISOString()} title={new Date(object.at).toLocaleString(t('activity.locale'))}>{new Date(object.at).toLocaleDateString() === new Date().toLocaleDateString() ? new Date(object.at).toLocaleTimeString(t('activity.locale'), { hour: '2-digit', minute: '2-digit' }) : new Date(object.at).toLocaleDateString(t('activity.locale'), { month: 'short', day: 'numeric' })}</time>}</span>
          <span className="dsh-bot-mode-preview">{object.unread > 0 && (preferences.read[object.key] ?? 0) < object.at && <span className="dsh-bot-mode-unread" role="img" aria-label={t('botMode.unread')} />}{pinned && <span className="dsh-bot-mode-pin" role="img" aria-label={t('botMode.pinned')}>⌖</span>}{duplicate ? subtitle : object.preview || (object.group?.running ? t('botMode.running') : subtitle)}</span>
          {duplicate && object.preview && <span className="dsh-bot-mode-preview">{object.preview}</span>}
        </span>
      </button>
      <Menu open={menu} onClose={() => setMenu(false)} portal autoFocus align="end" className="dsh-bot-mode-row-menu" anchor={<Button variant="ghost" size="sm" className="dsh-bot-mode-icon" data-bot-mode-object-menu={object.key} aria-label={t('botMode.objectMenu', { name: object.name })} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><IconEllipsisOutlineRegular size={16} /></Button>}
        items={[{ id: 'pin', label: t(pinned ? 'botMode.unpin' : 'botMode.pin', { name: object.name }) }, ...(object.group ? [{ id: 'archive', label: t('botMode.archiveNamed', { name: object.name }), disabled: blocked }] : [])]}
        footer={blocked ? [{ id: 'archive-hint', type: 'label', text: t('botMode.stopBeforeArchive') }] : []}
        onSelect={action => {
          setMenu(false);
          if (action === 'pin') { preferences.pinned = pinned ? preferences.pinned.filter(key => key !== object.key) : [...preferences.pinned, object.key]; save(); update({}); }
          if (action === 'archive' && object.group && !blocked) void groups.remote().archive(groupKey(object.group.group), object.group.group.revision).then(async result => {
            if (!result.ok) throw result.error;
            await groups.catalog.refresh();
          }).catch(() => update({ failure: true }));
        }} />
    </div>;
  }
  function Sidebar({ collapsed }: PropsRuntime<'sidebar'>) {
    sidebarCollapsed = collapsed;
    const catalog = useObjects();
    const view = useSyncExternalStore(source.subscribe, source.getSnapshot);
    const input = useRef<HTMLInputElement>(null);
    const [menu, setMenu] = useState(false);
    useEffect(() => { if (view.sequence && !collapsed) input.current?.focus(); }, [view.sequence, collapsed]);
    const rows = sortObjects(catalog.rows, view.query, preferences.pinned);
    const sections = splitObjectSections(rows, preferences.pinned, view.query);
    const searching = Boolean(view.query.trim());
    const pinnedRows = searching ? [] : sections.recent.filter(object => preferences.pinned.includes(object.key));
    const recentRows = searching ? sections.recent : sections.recent.filter(object => !preferences.pinned.includes(object.key));
    return <aside className="dsh-bot-mode dsh-bot-mode-sidebar" data-bot-mode-sidebar="" data-collapsed={collapsed ? '' : undefined} aria-label={t('botMode.title')}>
      <style>{css}</style><header className="dsh-bot-mode-brand">
        <button type="button" className="dsh-bot-mode-icon dsh-bot-mode-brand-mark" aria-label={t('botMode.toggleList')} onClick={() => ctx.layout.toggleSidebar()}><BrandMark size={26} /></button>
        {!collapsed && <><div className="dsh-bot-mode-brand-copy"><strong>{t('botMode.brand')}</strong><span>{t('botMode.modeActive')}</span></div>
          <Menu open={menu} onClose={() => setMenu(false)} portal autoFocus align="end" anchor={<Button variant="ghost" size="sm" className="dsh-bot-mode-icon" data-bot-mode-add-menu="" aria-label={t('botMode.add')} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}><IconPlusOutlineRegular size={18} /></Button>}
            items={[{ id: 'bot', label: t('botMode.newBot') }, { id: 'group', label: t('botMode.newGroup') }]} onSelect={action => { setMenu(false); manage(action === 'bot' ? 'bots' : 'groups', true); }} /></>}
      </header>
      {!collapsed && <><label className="dsh-bot-mode-search"><IconSearchOutlineRegular size={15} /><input data-bot-mode-search="" aria-label={t('botMode.search')} placeholder={t('botMode.search')} ref={input} value={view.query} onChange={event => update({ query: event.target.value })} /></label>
      {(catalog.failed || view.failure) && <div className="dsh-bot-mode-notice" role="alert">{t('botMode.unavailable')}<button type="button" className="dsh-bot-mode-link" onClick={refresh}>{t('bots.refresh')}</button></div>}
      {!catalog.ready && <p className="dsh-bot-mode-notice" role="status">{t('groups.loading')}</p>}
      <nav className="dsh-bot-mode-objects" aria-label={t('botMode.objects')}>
        {pinnedRows.length > 0 && <section data-bot-mode-section="pinned"><p className="dsh-bot-mode-section-label">{t('botMode.pinned')}</p>{pinnedRows.map(object => <ContactRow key={object.key} object={object} rows={catalog.rows} selected={view.selected} />)}</section>}
        {recentRows.length > 0 && <section data-bot-mode-section={searching ? 'search' : 'recent'}>{!searching && <p className="dsh-bot-mode-section-label">{t('botMode.recent')}</p>}{recentRows.map(object => <ContactRow key={object.key} object={object} rows={catalog.rows} selected={view.selected} />)}</section>}
        {sections.earlier.length > 0 && <details className="dsh-bot-mode-earlier" data-bot-mode-earlier=""><summary>{t('botMode.earlierGroups')} <span>{sections.earlier.length}</span></summary>{sections.earlier.map(object => <ContactRow key={object.key} object={object} rows={catalog.rows} selected={view.selected} />)}</details>}
        {catalog.ready && !rows.length && <div className="dsh-bot-mode-list-empty" role="status" data-bot-mode-list-empty=""><p>{t(view.query.trim() ? 'botMode.noMatches' : 'botMode.noObjects')}</p>{!view.query.trim() && !catalog.rows.length && <button type="button" className="dsh-bot-mode-link" onClick={() => manage('bots', true)}>{t('botMode.newBot')}</button>}</div>}
      </nav><footer className="dsh-bot-mode-footer"><ModeSwitcher actions={actions} t={t} onOpenSettings={() => ctx.layout.selectPanel('plugins' as MainPanelId)} /><Button variant="ghost" size="sm" data-bot-mode-settings="" aria-label={t('botMode.manageBots')} onClick={() => manage()}><IconSettingsOutlineRegular size={16} /><span>{t('simple.manage')}</span></Button></footer></>}
    </aside>;
  }
  function Leading() {
    return <div className="dsh-bot-mode dsh-bot-mode-leading"><style>{css}</style><button type="button" className="dsh-bot-mode-icon" aria-label={t('botMode.toggleList')} onClick={() => ctx.layout.toggleSidebar()}><BrandMark size={24} /></button></div>;
  }
  function ComposerDockFloor() {
    const presentation = useContext(BotModePresentation);
    // The public dock adds its real native activity/usage pills after a first
    // response. Reserve their one-line seat from the start; never suppress the
    // native entries or alter their controls. Outside this occurrence it is null.
    return presentation ? <span className="dsh-bot-mode-dock-floor" data-bot-mode-dock-floor="" aria-hidden="true" /> : null;
  }
  function ConversationViews(props: ConversationViewsProps) {
    const session = props.useSession(value => value);
    const conversation = props.useConversation(value => value);
    const input = props.useInput(value => value);
    const catalog = useObjects();
    const object = findObjectForSession(catalog.rows, props.sessionId);
    const blank = session.blank && !session.running && !session.awaitingFirstTurn && !conversation.activeTargets.size;
    return <div className="dsh-bot-mode-views" data-bot-mode-views="">
      {blank && object?.bot && <section className="dsh-bot-mode-welcome" data-bot-mode-empty="">
        <Identity object={object} objects={catalog.rows} size={54} /><h2>{object.name}</h2><p>{object.bot.description || t('chat.firstMessage')}</p>
        <span>{t('botMode.emptyHint')}</span><div className="dsh-bot-mode-examples">{(['plan', 'review'] as const).map(example => <button className="dsh-bot-mode-example" type="button" key={example} disabled={Boolean(input.draft) || input.phase !== 'plain'} onClick={() => {
          props.inputActions.setDraft(t(`botMode.example.${example}`)); props.inputActions.persistDraft();
        }}>{t(`botMode.example.${example}`)}</button>)}</div>
      </section>}
      {/* The Bot header has no native view tabs; select Chat for this occurrence without changing the saved native view. */}
      {props.renderSlot('conversation.session', { view: 'chat' })}
    </div>;
  }
  function Conversation(props: PropsRuntime<'main.conversation'> & PropsRenderFactories) {
    const catalog = useObjects();
    const object = findObjectForSession(catalog.rows, props.sessionId);
    const session = props.useSession(value => value);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [detailsSection, setDetailsSection] = useState<DetailSection>('details');
    const detailsButton = useRef<HTMLButtonElement>(null), detailsSurface = useRef<HTMLElement>(null), nativeContent = useRef<HTMLDivElement>(null);
    const closeDetails = () => { setDetailsOpen(false); detailsButton.current?.focus(); };
    useEffect(() => {
      if (!detailsOpen) return;
      detailsSurface.current?.querySelector<HTMLButtonElement>('button')?.focus();
      const media = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 700px)') : undefined;
      const content = nativeContent.current;
      const updateInert = () => { if (content) content.inert = media?.matches ?? false; };
      updateInert(); media?.addEventListener?.('change', updateInert);
      return () => { if (content) content.inert = false; media?.removeEventListener?.('change', updateInert); };
    }, [detailsOpen]);
    const identity = object?.key, kind = object?.kind, id = object?.id, createdAt = object?.createdAt, at = object?.at;
    const restored = useRef(false);
    useEffect(() => {
      if (restored.current || !catalog.ready || props.sessionId !== undefined) return;
      restored.current = true;
      const previous = preferences.selected;
      const target = previous && catalog.rows.find(row => row.key === objectKey(previous));
      if (target) void select(target);
    }, [catalog.ready, catalog.rows, props.sessionId]);
    useEffect(() => {
      if (!catalog.ready || !identity || !kind || id === undefined || createdAt === undefined || at === undefined) return;
      const previous = preferences.selected;
      if (previous?.kind !== kind || previous.id !== id || previous.createdAt !== createdAt || preferences.read[identity] !== at) {
        preferences.selected = { kind, id, createdAt }; preferences.read[identity] = at; save();
      }
      update({ selected: identity });
    }, [catalog.ready, identity, kind, id, createdAt, at]);
    useEffect(() => {
      setDetailsOpen(false); setDetailsSection('details');
      if (!identity) return;
      // Collapse only on object navigation. Fresh activity/read receipts must
      // not close a details pane that the user has just opened.
      const sidebar = ctx.get('sidebarRight');
      if (sidebar?.isExpanded()) sidebar.toggleExpanded();
    }, [identity]);
    if (!catalog.ready) return <div className="dsh-bot-mode dsh-bot-mode-state" role={catalog.failed ? 'alert' : 'status'}><style>{css}</style>{t(catalog.failed ? 'botMode.unavailable' : 'groups.loading')}<button className="dsh-bot-mode-link" type="button" onClick={refresh}>{t('bots.refresh')}</button></div>;
    if (!object) return <div className="dsh-bot-mode dsh-bot-mode-state" role="status" data-bot-mode-unavailable=""><style>{css}</style><BotBrandGlyph size={48} /><p>{t(props.sessionId ? 'botMode.linkUnavailable' : catalog.rows.length ? 'botMode.choose' : 'botMode.noObjects')}</p><button className="dsh-bot-mode-link" type="button" onClick={() => catalog.rows.length ? search() : manage('bots', true)}>{t(catalog.rows.length ? 'botMode.backToList' : 'botMode.newBot')}</button></div>;
    const origin = object.group?.group.supergroup?.originSessionId;
    const owner = origin ? findObjectForSession(catalog.rows, origin) : undefined;
    return <BotModePresentation.Provider value={true}><div className="dsh-bot-mode dsh-bot-mode-chat" data-bot-mode-object={object.kind}>
      <style>{css}</style><header className="dsh-bot-mode-header"><button className="dsh-bot-mode-icon dsh-bot-mode-back" data-bot-mode-back="" type="button" aria-label={t('botMode.backToList')} onClick={() => ctx.layout.toggleSidebar()}><IconChevronDownOutlineRegular size={18} /></button><Identity object={object} objects={catalog.rows} size={34} /><div className="dsh-bot-mode-heading"><strong data-bot-mode-title="" title={object.name}>{object.name}</strong><span>{object.workState ? t(`supergroup.${object.workState}`) : object.group?.running ? t('botMode.running') : describe(object, catalog.rows)}</span></div>
        {owner && <button type="button" className="dsh-bot-mode-link dsh-bot-mode-origin" data-bot-mode-origin="" onClick={() => { void select(owner); }}>{t('botMode.backToBot', { name: owner.name })}</button>}
        <button ref={detailsButton} className="dsh-bot-mode-icon" data-bot-mode-details="" aria-expanded={detailsOpen} type="button" title={t('botMode.detailsAndMaterials')} aria-label={t('botMode.detailsAndMaterials')} onClick={() => {
          const sidebar = ctx.get('sidebarRight');
          if (sidebar?.isExpanded()) sidebar.toggleExpanded();
          setDetailsOpen(value => !value);
        }}><IconDataOutlineRegular size={19} /></button>
      </header>
      {catalog.failed && <div className="dsh-bot-mode-notice" role="alert">{t('botMode.connectionLost')}<button type="button" className="dsh-bot-mode-link" onClick={refresh}>{t('bots.refresh')}</button></div>}
      <div className="dsh-bot-mode-chat-region"><div ref={nativeContent} className="dsh-bot-mode-conversation">
      <div className="dsh-bot-mode-native-frame" data-bot-mode-content-frame="">{props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: session?.openState === 'open' ? 'active' : 'settling', hero: false }, { slots: { views: ConversationViews } })}</div>
      </div>{detailsOpen && <aside ref={detailsSurface} className="dsh-bot-mode-detail-surface" aria-label={t('botMode.detailsAndMaterials')} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeDetails(); }
        if (event.key === 'Tab' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 700px)').matches) {
          const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]')]
            .filter(element => {
              if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false;
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false;
              }
              return true;
            });
          const first = elements[0], last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}><DetailsBody object={object} rows={catalog.rows} section={detailsSection} setSection={setDetailsSection} onClose={closeDetails} /></aside>}</div>
    </div></BotModePresentation.Provider>;
  }
  function WorkMaterials({ object }: { object: BotModeObject }) {
    const snapshot = useSyncExternalStore(workCatalog.subscribe, workCatalog.getSnapshot);
    const matching = snapshot.works.filter(({ work }) => object.bot
      ? work.owner.botId === object.id && work.owner.botCreatedAt === object.createdAt && work.originSessionId === object.sessionId
      : work.group?.groupId === object.id && work.group.groupCreatedAt === object.createdAt)
      .sort((a, b) => b.work.updatedAt - a.work.updatedAt);
    const [chosen, setChosen] = useState<string>();
    const active = matching.find(row => row.work.id === chosen) ?? matching[0];
    if (!page.taskSupport) return null;
    return <section data-bot-mode-task-materials="">
      <p>{t('simple.taskMaterialsHint')}</p>
      {matching.length > 1 && <label>{t('botPanel.tasks')}<select value={active?.work.id ?? ''} onChange={event => setChosen(event.target.value)}>{matching.map(({ work }) => <option key={work.id} value={work.id}>{new Date(work.createdAt).toLocaleString(t('activity.locale'))} · {t(`supergroup.${work.state}`)}</option>)}</select></label>}
      {active && <TaskSupportPanel key={active.work.id} workId={active.work.id} actions={page.taskSupport} integrations={page.integrations}
        bot={bots.getSnapshot().entries.find(row => row.bot.id === active.work.owner.botId && row.bot.createdAt === active.work.owner.botCreatedAt)?.bot}
        readOnly={['cancelled', 'unknown'].includes(active.work.state)} openSession={page.onOpenSession} t={t} />}
      {snapshot.error && <p role="alert">{t('supergroup.unavailable')}</p>}
    </section>;
  }
  function Materials({ object }: { object: BotModeObject }) {
    const [catalog] = useState(() => object.group ? groups.createView(groupKey(object.group.group)) : undefined);
    const empty = useRef<ReturnType<ReturnType<GroupActions['createView']>['getSnapshot']>>({ view: undefined, loaded: true, loading: false, pollIntervalMs: 5000 });
    const snapshot = useSyncExternalStore(catalog?.subscribe ?? (() => () => {}), catalog?.getSnapshot ?? (() => empty.current));
    const [opening, setOpening] = useState(false), [openFailed, setOpenFailed] = useState<'attachment' | 'result'>();
    const pending = useRef(false), mounted = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; catalog?.dispose(); }; }, [catalog]);
    const open = (kind: 'attachment' | 'result', action: () => Promise<unknown>) => {
      if (pending.current) return;
      pending.current = true; setOpening(true); setOpenFailed(undefined);
      void (async () => {
        try { await action(); }
        catch { if (mounted.current) setOpenFailed(kind); }
        finally { pending.current = false; if (mounted.current) setOpening(false); }
      })();
    };
    if (!object.group) return <WorkMaterials key={object.key} object={object} />;
    const results = snapshot.view?.deliveries.flatMap(delivery => {
      const message = snapshot.view?.messages.find(row => row.id === delivery.outputMessageId);
      return delivery.state === 'completed' && message ? [{ delivery, message }] : [];
    }) ?? [];
    return <section className="dsh-bot-mode-materials" aria-busy={opening}><WorkMaterials key={object.key} object={object} /><p className="dsh-bot-mode-muted">{t('botMode.materialScope')}</p>
      {snapshot.error && <p role="alert">{t('groups.disconnected')} <button className="dsh-bot-mode-link" type="button" onClick={() => { void catalog?.refresh(); }}>{t('bots.refresh')}</button></p>}
      {openFailed && <p role="alert">{t(openFailed === 'attachment' ? 'groups.attachmentUnavailable' : 'activity.openError')}</p>}
      {results.length > 0 && <section><h4>{t('botMode.results')}</h4>{results.map(({ delivery, message }) => <button className="dsh-bot-mode-action" key={delivery.id} type="button" disabled={opening} onClick={() => {
        open('result', () => groups.openRun(groupKey(object.group!.group), delivery.turnId, undefined, { messageId: message.id, seq: message.seq }));
      }}>{t('botMode.resultBy', { name: message.speaker?.name ?? object.name })}</button>)}</section>}{snapshot.view?.messages.filter(message => message.authorKind === 'user' || message.attachments?.length).map(message => <article key={message.id}>
      {message.authorKind === 'user' && <p>{message.text}</p>}
      {message.attachments?.map(attachment => <button className="dsh-bot-mode-action" type="button" key={attachment.attachment.attachmentId} disabled={opening} onClick={() => {
        open('attachment', async () => { const result = await groups.remote().openAttachment(groupKey(object.group!.group), message.id, attachment.attachment.attachmentId); if (!result.ok) throw result.error; });
      }}>{attachment.type === 'file' ? attachment.attachment.name : t('groups.attachments')}</button>)}
    </article>)}{!snapshot.view && !snapshot.error && <p role="status">{t('groups.loading')}</p>}</section>;
  }
  function Details(props: PropsRuntime<'sidebar.right.pane.tab'>) {
    const catalog = useObjects();
    const object = findObjectForSession(catalog.rows, props.sessionId);
    const tab = props.useTabInfo().tab;
    const initial = (tab.navigation.params as { section?: DetailSection } | undefined)?.section ?? 'details';
    const [section, setSection] = useState<DetailSection>(initial);
    const revision = tab.navigation.revision;
    const acceptedNavigation = useRef({ revision, initial });
    useEffect(() => {
      if (acceptedNavigation.current.revision === revision && acceptedNavigation.current.initial === initial) return;
      acceptedNavigation.current = { revision, initial };
      setSection(initial);
    }, [revision, initial]);
    if (!object) return <p role="status">{t('botMode.unavailable')}</p>;
    return <DetailsBody object={object} rows={catalog.rows} section={section} setSection={setSection} onClose={() => ctx.get('sidebarRight')?.toggleExpanded()} />;
  }
  function DetailsBody({ object, rows, section, setSection, onClose }: { object: BotModeObject; rows: BotModeObject[]; section: DetailSection; setSection(value: DetailSection): void; onClose(): void }) {
    const [stopping, setStopping] = useState(false), [stopFailed, setStopFailed] = useState(false);
    const owner = object.group?.group.supergroup ? findObjectForSession(rows, object.group.group.supergroup.originSessionId) : undefined;
    const activeMembers = object.group?.members.filter(member => member.enabled && member.removedAt === undefined).length ?? 0;
    return <section className="dsh-bot-mode dsh-bot-mode-details" data-bot-mode-details-panel=""><style>{css}</style><header className="dsh-bot-mode-details-heading"><h3>{t('botMode.detailsAndMaterials')}</h3><button type="button" className="dsh-bot-mode-icon" aria-label={t('botMode.closeDetails')} onClick={onClose}><IconCloseOutlineRegular size={17} /></button></header>
      <div className="dsh-bot-mode-profile" data-bot-mode-profile=""><Identity object={object} objects={rows} size={54} /><strong title={object.name}>{object.name}</strong><p>{object.bot ? object.bot.description || t('chat.firstMessage') : t('supergroup.members', { count: activeMembers })}</p></div>
      <nav className="dsh-bot-mode-tabs" aria-label={t('botMode.details')}>
      {(['details', 'tasks', 'materials', ...(object.group ? ['members' as const, 'settings' as const] : [])] as const).map(value => <button className="dsh-bot-mode-tab" data-bot-mode-tab={value} type="button" key={value} aria-pressed={value === section} onClick={() => setSection(value)}>{t(value === 'tasks' ? 'botPanel.tasks' : value === 'settings' ? 'simple.groupSettings' : `botMode.${value}`)}</button>)}
    </nav>{object.group?.group.supergroup && (object.workState === 'creating' || object.workState === 'running') && <button className="dsh-bot-mode-action" data-bot-mode-stop="" type="button" disabled={stopping} onClick={() => {
      setStopping(true); setStopFailed(false);
      const group = groupKey(object.group!.group);
      const remote = ctx.get('remote.dshBotSupergroup');
      void (async () => {
        if (!remote) throw new Error('Supergroup unavailable');
        await stopGroupWork(object.group!.group, {
          async read() { const result = await remote.byGroup({ group }); if (!result.ok) throw result.error; return supergroupViewSchema.nullable().parse(result.value); },
          async cancel(work) { const result = await remote.cancel({ workId: work.id, expectedRevision: work.revision }); if (!result.ok) throw result.error; },
          async refresh() { await Promise.all([groups.catalog.refresh(), workCatalog.refresh()]); },
        });
      })().catch(() => setStopFailed(true)).finally(() => setStopping(false));
    }}>{t('supergroup.stop')}</button>}{stopFailed && <p role="alert">{t('botMode.unavailable')}</p>}{section === 'tasks' && object.bot && page.followUp ? <FollowUpPanel key={object.key} source={page.followUp} subject={{ kind: 'bot', bot: { botId: object.id, botCreatedAt: object.createdAt } }} mode="detail" navigation={{
      canOpen: origin => origin.kind === 'work' || !!followUpSessionTarget(origin),
      open: async (origin, signal) => {
        if (origin.kind === 'work') page.onOpenFollowUpWork?.({ botId: object.id, botCreatedAt: object.createdAt }, origin.ticketId);
        else await page.followUp?.openSession(origin, signal, true);
      },
    }} t={t} /> : (section === 'tasks' || section === 'settings') && object.group ? <GroupOverview key={object.key} summary={object.group} actions={groups} bots={rows.flatMap(row => row.bot ? [row.bot] : [])} section={section === 'tasks' ? 'activity' : 'settings'} showHeader={false} showTabs={false} compactSettings executionBridge={dependencies.executionBridge} t={t} /> : section === 'materials' ? <Materials key={object.key} object={object} /> : section === 'members' && object.group ? <GroupMembersList key={object.key} summary={object.group} actions={groups} bots={rows.flatMap(row => row.bot ? [row.bot] : [])} openBotLabel={t('chat.openChat')} onOpenBot={bot => {
        const target = rows.find(row => row.bot?.id === bot.id && row.bot.createdAt === bot.createdAt);
        if (target) { onClose(); void select(target); }
      }} t={t} /> : object.group ? <div className="dsh-bot-mode-group-details" data-bot-mode-group-details="">
        <h4>{t('botMode.groupGoal')}</h4><p>{object.goal || object.name}</p>
        <dl><dt>{t('botMode.groupStatus')}</dt><dd>{object.workState ? t(`supergroup.${object.workState}`) : t(object.group.running ? 'botMode.running' : 'groups.ready')}</dd>
          <dt>{t('botMode.groupOrigin')}</dt><dd>{owner ? <button className="dsh-bot-mode-link" type="button" onClick={() => { onClose(); void select(owner); }}>{owner.name}</button> : t(object.group.group.supergroup ? 'botMode.originUnavailable' : 'botMode.manualGroup')}</dd>
          <dt>{t('botMode.members')}</dt><dd>{t('supergroup.members', { count: activeMembers })}</dd></dl>
        <p className="dsh-bot-mode-muted">{t(object.group.group.supergroup ? 'botMode.groupScope' : 'botMode.materialScope')}</p>
      </div> : <>
      <button className="dsh-bot-mode-action" type="button" onClick={() => { onClose(); ctx.get('sidebarRight')?.openTab(BOT_PANEL_KIND, { params: { botId: object.id, botCreatedAt: object.createdAt, section: 'overview' } }); }}>{t('botMode.botDetails')}</button>
      <button className="dsh-bot-mode-action" type="button" onClick={() => { onClose(); dependencies.memory(object); }}>{t('botMode.memory')}</button></>}
      {section === 'details' && <details className="dsh-bot-mode-advanced" data-bot-mode-advanced=""><summary>{t('botMode.advanced')}</summary><dl><dt>{t('botMode.identity')}</dt><dd>{object.id}</dd><dt>{t('botMode.created')}</dt><dd>{new Date(object.createdAt).toLocaleString(t('activity.locale'))}</dd></dl></details>}
    </section>;
  }
  let commandService: CommandModeService | undefined;
  let requestedEnabled = false;
  const lifecycle = createModeLifecycle({ service: () => commandService ?? ctx.get('shortcuts') as unknown as CommandModeService | undefined,
    newBot: () => manage('bots', true), search, newLabel: () => t('botMode.newBot'), searchLabel: () => t('botMode.search'), blocked: () => t('botMode.sessionBlocked'),
    install() {
      const disposers: Array<() => void | Promise<void>> = [];
      try {
        disposers.push(ctx.effect(() => ctx.slots.inject('sidebar', () => ctx.slots.register({ name: 'sidebar', priority: -100 }, Sidebar)), 'dsh-bot: mode sidebar'));
        disposers.push(ctx.effect(() => ctx.slots.inject('shell.leading', () => ctx.slots.register({ name: 'shell.leading', priority: -100 }, Leading)), 'dsh-bot: mode leading'));
        disposers.push(ctx.effect(() => ctx.slots.inject('main.conversation', () => ctx.slots.register({ name: 'main.conversation', priority: -100 }, Conversation)), 'dsh-bot: mode conversation'));
        disposers.push(ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-bot-mode-floor', order: -100 }, ComposerDockFloor)), 'dsh-bot: stable native composer dock'));
        disposers.push(ctx.effect(() => modeSettings.subscribe(() => {}), 'dsh-bot: active mode settings lease'));
        const detailsScope = ctx.inject(['sidebarRight', 'sidebarRightTabs'], scope => {
          scope.effect(() => scope.sidebarRightTabs.register({ id: 'dsh-bot.mode-details', kind: 'dsh-bot-mode-details', title: () => t('botMode.details') }), 'dsh-bot: object details tab');
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-bot.mode-details' }, Details)), 'dsh-bot: object details panel');
        });
        disposers.push(() => detailsScope.dispose());
      } catch (error) { for (const dispose of disposers.reverse()) void dispose(); throw error; }
      return async () => { ++navigation; for (const dispose of disposers.reverse()) await dispose(); };
    },
  });
  function ModeStatus() {
    const status = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot);
    if (status.state !== 'starting' && status.state !== 'failed') return null;
    return <div className="dsh-bot-mode dsh-bot-mode-state" data-bot-mode-status={status.state} data-bot-mode-reason={status.reason}
      role={status.state === 'failed' ? 'alert' : 'status'} style={{ pointerEvents: 'auto', position: 'fixed', insetInline: 16, bottom: 16,
        padding: 12, border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8 }}>
      <style>{css}</style>{t(status.state === 'failed' ? 'botMode.notReady' : 'groups.loading')}
      {status.state === 'failed' && <button className="dsh-bot-mode-action" type="button" onClick={() => { void reconcile(); }}>{t('bots.refresh')}</button>}
    </div>;
  }
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-bot-mode-status' }, ModeStatus)), 'dsh-bot: visible mode readiness');
  ctx.effect(() => () => { live = false; ++navigation; listeners.clear(); return lifecycle.dispose(); }, 'dsh-bot: Bot mode lifetime');
  let guardReleases: Array<() => void> = [];
  function Guard() {
    const status = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot);
    return <section className="dsh-bot-mode dsh-bot-mode-state" data-bot-mode-guard="" role={status.state === 'failed' ? 'alert' : 'status'}>
      <style>{css}</style><p>{t(status.state === 'failed' ? 'botMode.notReady' : 'groups.loading')}</p>
      <ModeSwitcher actions={actions} t={t} />
      <button className="dsh-bot-mode-action" type="button" onClick={() => { void reconcile(); }}>{t('bots.refresh')}</button>
      <button className="dsh-bot-mode-action" type="button" onClick={() => ctx.layout.selectPanel('plugins' as MainPanelId)}>{t('botMode.modeSettings')}</button>
    </section>;
  }
  const guard = (enabled: boolean) => {
    if (enabled && !live) return;
    if (!enabled) { for (const release of guardReleases.splice(0).reverse()) void release(); return; }
    if (guardReleases.length) return;
    guardReleases = [
      ctx.effect(() => ctx.slots.inject('sidebar', () => ctx.slots.register({ name: 'sidebar', priority: -200 }, Guard)), 'dsh-bot: pending mode navigation guard'),
      ctx.effect(() => ctx.slots.inject('shell.leading', () => ctx.slots.register({ name: 'shell.leading', priority: -200 }, Guard)), 'dsh-bot: pending mode leading guard'),
      ctx.effect(() => ctx.slots.inject('main.conversation', () => ctx.slots.register({ name: 'main.conversation', priority: -200 }, Guard)), 'dsh-bot: pending mode conversation guard'),
    ];
  };
  ctx.effect(() => () => guard(false), 'dsh-bot: mode guard lifetime');
  const settings = async () => {
    let value: { enabled: boolean };
    try { value = await dependencies.settings.settings(); }
    catch (error) { guard(true); await lifecycle.fail('settings-unavailable'); throw error; }
    if (!live) return value;
    requestedEnabled = value.enabled;
    if (value.enabled) {
      if (lifecycle.getSnapshot().state !== 'ready') guard(true);
      await lifecycle.enable();
      guard(false);
    } else { await lifecycle.disable(); guard(false); }
    return value;
  };
  // An active mode uses the existing shared scheduler. A disabled mode has no
  // polling lease; native push and explicit wake events recheck shared settings.
  let changing = false;
  const modeSettings = createPollingCatalog(ctx, { enabled: false }, async () => {
    const value = await dependencies.settings.settings();
    if (!live) return value;
    requestedEnabled = value.enabled;
    if (!changing) {
      if (value.enabled) { if (lifecycle.getSnapshot().state !== 'ready') guard(true); await lifecycle.enable(); guard(false); }
      else { if (lifecycle.getSnapshot().state !== 'failed') await lifecycle.disable(); guard(false); }
    }
    return value;
  });
  let reconciling: Promise<void> | undefined;
  let again = false;
  const reconcile = (): Promise<void> => {
    if (!live) return Promise.resolve();
    if (changing) { again = true; return Promise.resolve(); }
    if (reconciling) { again = true; return reconciling; }
    const task = (async () => {
      do { again = false; try { await settings(); } catch { /* Keep explicit readiness status. */ } }
      while (again && live && !changing);
    })().finally(() => { if (reconciling === task) reconciling = undefined; });
    reconciling = task; return task;
  };
  const settingsStream = createChangeStream(ctx, () => { void reconcile(); });
  ctx.effect(() => {
    const view = typeof window === 'undefined' ? undefined : window;
    const page = typeof document === 'undefined' ? undefined : document;
    const wake = () => { if (!live) return; settingsStream.start(); void reconcile(); };
    const visibility = () => { if (page?.visibilityState !== 'hidden') wake(); };
    const reconnect = ctx.on('connection/reset', () => { void settingsStream.stop().then(wake); });
    // Lightweight artifact contract tests intentionally expose only a partial
    // window. Browser listeners are optional; no timer is needed while off.
    view?.addEventListener?.('focus', wake);
    page?.addEventListener?.('visibilitychange', visibility);
    const shortcutScope = ctx.inject(['shortcuts'], scope => {
      const service = scope.get('shortcuts') as unknown as CommandModeService;
      commandService = service;
      if (service.modePresentation?.subscribe) scope.effect(() => service.modePresentation.subscribe(wake), 'dsh-bot: chat action capability readiness');
      wake();
      scope.effect(() => () => {
        if (commandService !== service || !live) return;
        commandService = undefined;
        if (requestedEnabled) guard(true);
        void lifecycle.disable().then(() => reconcile());
      }, 'dsh-bot: command service generation');
    });
    guard(true); wake();
    return () => { void shortcutScope.dispose(); reconnect(); view?.removeEventListener?.('focus', wake); page?.removeEventListener?.('visibilitychange', visibility); return settingsStream.stop(); };
  }, 'dsh-bot: mode settings push lifetime');
  const actions: BotModeActions = { settings, status: lifecycle,
    async configure(input) {
      changing = true;
      let hostAttempted = false;
      try {
        if (input.enabled) await lifecycle.prepare();
        hostAttempted = true;
        const next = await dependencies.settings.configure(input);
        requestedEnabled = next.enabled;
        if (!next.enabled) { await lifecycle.disable(); guard(false); }
        else { guard(true); await lifecycle.enable(); guard(false); ctx.layout.selectPanel(null); }
        return next;
      } catch (error) {
        // Read after uncertain transport before restoring. Never claim that a
        // failed RPC proves the Host did not commit its global setting.
        try { if (hostAttempted) await settings(); } catch { /* Status retains the capability/read failure. */ }
        throw error;
      } finally { changing = false; if (again) void reconcile(); }
    },
  };
  return actions;
}
