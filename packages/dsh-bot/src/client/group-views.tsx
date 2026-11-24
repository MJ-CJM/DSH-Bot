import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupSummary, GroupView } from '../shared/groups.js';
import type { BotRecord } from '../shared/schema.js';
import type { GroupActivityFocus } from './group-management.js';
import type { GroupActions } from './groups-state.js';
import type { BotCatalog } from './state.js';
import type { ExecutionBridge } from './group-execution.js';
import type { GroupOverviewSection } from './components/GroupOverview.js';
import { GroupRosterEditor } from './components/GroupsPanel.js';
import { GroupOverview } from './components/GroupOverview.js';
import { SettingsDrafts, useSettingsNavigation } from './components/SettingsNavigation.js';
import styles from './styles/groups.module.css';
import css from './styles/groups.module.css?inline';

export const GROUP_MANAGEMENT_VIEW = 'dsh-bot-group-management';

type ViewProps = PropsRuntime<'conversation.view'> & PropsLocale<'dsh-bot'> & {
  summary: GroupSummary;
  actions: GroupActions;
  bots: BotCatalog;
  executionBridge?: ExecutionBridge;
  onOpenBot?(bot: BotRecord): void;
  onAskBot?(bot: BotRecord, prompt: string, signal?: AbortSignal): void | Promise<void>;
};

export function GroupWorkspaceView({ summary, actions, bots, executionBridge, onOpenBot, onAskBot,
  viewRequest, openView, completeViewRequest, t }: ViewProps) {
  const navigation = useSettingsNavigation(t);
  const botState = useSyncExternalStore(bots.subscribe, bots.getSnapshot);
  const runRequest = useSyncExternalStore(actions.runRequests.subscribe, actions.runRequests.getSnapshot);
  const [editing, setEditing] = useState<GroupView>();
  const [section, setSection] = useState<GroupOverviewSection>('members');
  const [focus, setFocus] = useState<{ sequence: number; request?: GroupActivityFocus }>({ sequence: 0 });
  const focusRun = useCallback((turnId?: string) => {
    setFocus(previous => {
      const sequence = previous.sequence + 1;
      return { sequence, request: turnId ? { turnId, sequence } : undefined };
    });
    setSection('activity');
  }, []);
  useEffect(() => {
    if (runRequest?.sessionId !== summary.group.rootSessionId) return;
    actions.consumeRunRequest(runRequest.requestId);
    focusRun(runRequest.turnId);
  }, [actions, focusRun, runRequest, summary.group.rootSessionId]);
  useEffect(() => {
    if (viewRequest?.view === GROUP_MANAGEMENT_VIEW) {
      focusRun(viewRequest.focus);
      completeViewRequest();
    }
  }, [viewRequest, completeViewRequest, focusRun]);
  return <section className={`${styles.panel} ${styles.managementPanel}`} data-group-view={GROUP_MANAGEMENT_VIEW}>
    <style>{css}</style>
    {editing ? <SettingsDrafts.Provider value={navigation.registry}>
      <GroupRosterEditor bots={botState.entries.map(row => row.bot)} initial={editing} actions={actions} t={t}
        onClose={() => setEditing(undefined)} />
      {navigation.confirmation}
    </SettingsDrafts.Provider> : <GroupOverview summary={summary} actions={actions}
      bots={botState.entries.map(row => row.bot)} onOpenBot={onOpenBot} onAskBot={onAskBot}
      onEdit={setEditing}
      onOpenRun={(_view, turnId) => openView(GROUP_MANAGEMENT_VIEW, turnId)}
      executionBridge={executionBridge}
      section={section} onSectionChange={setSection} showHeader={false}
      focusRequest={focus.request} t={t} />}
  </section>;
}

export function registerGroupViews(ctx: Context, actions: GroupActions, bots: BotCatalog, executionBridge: ExecutionBridge,
  onOpenBot?: (bot: BotRecord) => void, onAskBot?: (bot: BotRecord, prompt: string, signal?: AbortSignal) => void | Promise<void>) {
  return ctx.effect(() => {
    // Empty catalogs can activate before the optional native session surface is available.
    const sessions = () => (ctx.sessions as unknown as ISessions).list;
    let active = true;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let offSessions: (() => void) | undefined;
    let registered: { group: GroupSummary['group']; release: () => void } | undefined;
    const clear = () => {
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
      offSessions?.();
      offSessions = undefined;
      registered?.release();
      registered = undefined;
    };
    const settle = () => {
      pending = undefined;
      if (!active) return;
      // Session retain notifications can pass through another group, no owner,
      // or a child while navigation is settling. Reconcile the latest snapshot.
      const groupRows = actions.catalog.getSnapshot().groups;
      const current = Object.values(sessions().getSnapshot().byId).find(row => (row.retainedBy?.mainView ?? 0) > 0);
      const summary = groupRows.find(row => row.group.rootSessionId === current?.id);
      const previous = registered?.group;
      const matchesPrevious = (group: GroupSummary['group']) => group.rootSessionId === previous?.rootSessionId
        && group.id === previous.id && group.createdAt === previous.createdAt;
      const keepRegistration = summary ? matchesPrevious(summary.group)
        : (!current || current.origin === 'subagent' || current.parentId) && groupRows.some(row => matchesPrevious(row.group));
      if (keepRegistration) return;
      registered?.release();
      registered = undefined;
      if (!summary) return;
      const { group } = summary;
      const release = ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', locale: 'dsh-bot', id: GROUP_MANAGEMENT_VIEW, order: 30, label: () => ctx.locale.bind('dsh-bot')('groups.manage'),
      }, (props: PropsRuntime<'conversation.view'> & PropsLocale<'dsh-bot'>) => {
        if (props.sessionId !== group.rootSessionId) return null;
        return <GroupWorkspaceView key={JSON.stringify([group.id, group.createdAt])} {...props} summary={summary} actions={actions} bots={bots}
          executionBridge={executionBridge} onOpenBot={onOpenBot} onAskBot={onAskBot} />;
      }));
      registered = { group, release };
    };
    const sync = () => {
      if (!active) return;
      if (!actions.catalog.getSnapshot().groups.length) { clear(); return; }
      offSessions ??= sessions().subscribe(sync);
      pending ??= setTimeout(settle, 0);
    };
    const offCatalog = actions.catalog.watch?.(sync) ?? (() => {});
    sync();
    return () => {
      active = false;
      offCatalog();
      clear();
    };
  }, 'dsh-bot: group conversation views');
}
