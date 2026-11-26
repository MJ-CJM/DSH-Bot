// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { relativeTime } from '../../src/client/activity-view.js';
import { formatDateTime, formatList, formatNumber, resolveLocale } from '../../src/client/format.js';
import { createGroupActions, type GroupActions } from '../../src/client/groups-state.js';
import { createGroupManagementViewStore, GroupWorkspaceView } from '../../src/client/group-views.js';
import { selectGroupComposer, WorkspaceGroupComposer } from '../../src/client/workspace-group.js';
import { registerBotMainGuard } from '../../src/client/bot-main-guard.js';
import { GroupSessionHover } from '../../src/client/components/GroupSessionRow.js';
import { GroupOverview } from '../../src/client/components/GroupOverview.js';
import { GroupTurnExecution } from '../../src/client/components/GroupTurnExecution.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import { TeamRecipes } from '../../src/client/components/TeamRecipes.js';
import { BackgroundTasksPanel } from '../../src/client/components/BackgroundTasksPanel.js';
import { CapabilitiesPanel } from '../../src/client/components/CapabilitiesPanel.js';
import { BotEditor } from '../../src/client/components/BotEditor.js';
import { SharedMemoryPanel } from '../../src/client/components/SharedMemoryPanel.js';
import { RoutinePanel } from '../../src/client/components/RoutinePanel.js';
import { NotificationsPanel } from '../../src/client/components/NotificationsPanel.js';
import { ConnectorEditor } from '../../src/client/components/ConnectorEditor.js';
import { MessageCard } from '../../src/client/messaging.js';
import { groupRootPresetName } from '../../src/host/groups/roots.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { GroupPermissionState } from '../../src/client/group-permission-state.js';
import type { BotCatalog } from '../../src/client/state.js';
import type { BackgroundActions } from '../../src/client/background-work-state.js';
import type { ModelActions } from '../../src/client/model-catalog-state.js';
import type { RoutineActions } from '../../src/client/automation-state.js';
import type { IntegrationActions } from '../../src/client/integrations-state.js';
import type { SharedMemoryBinding } from '../../src/client/components/SharedMemoryPanel.js';
import type { TeamRecipe } from '../../src/shared/team-recipes.js';
import { bots, summary, view } from './group-fixture.js';
import { bot, button, click, mountClient } from './helpers.js';

const mounted: Array<{ root: Root; element: HTMLDivElement; dispose?: () => Promise<void> }> = [];

afterEach(async () => {
  for (const item of mounted.splice(0).reverse()) {
    await act(async () => item.root.unmount());
    if (item.dispose) await item.dispose();
    item.element.remove();
  }
  vi.restoreAllMocks();
});

function makeT(language: 'en' | 'zh' = 'en'): PropsLocale<'dsh-bot'>['t'] {
  const dict = (language === 'en' ? en : zh).ui;
  return ((key: keyof typeof en.ui, params?: Record<string, unknown>) =>
    dict[key].replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? `{${name}}`))) as PropsLocale<'dsh-bot'>['t'];
}

function createHostMount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  return { element, root };
}

function makeBotCatalog(records = bots): BotCatalog {
  const snapshot = {
    entries: records.map((record) => ({
      bot: record,
      status: { id: record.id, presetId: `bot-${record.id}`, preset: { state: 'ok' as const } },
    })),
    loaded: true,
    loading: false,
    error: undefined,
  };
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    refresh: async () => {},
    dispose: () => {},
  } as unknown as BotCatalog;
}

describe('Issue #60: UI & visual bug fixes', () => {
  it('hides workspace group composer while Manage group view is mounted (including React StrictMode) and restores it on unmount', async () => {
    const ctx = new Context();
    const data = view();
    const row = summary();
    const remote = {
      view: async () => ({ ok: true, value: data }),
      list: async () => ({ ok: true, value: [row] }),
    } as unknown as GroupMethods;
    ctx.provide('remote.dshBot.groups', remote);
    const actions = createGroupActions(ctx, {});
    await actions.catalog.refresh();
    const botCatalog = makeBotCatalog();
    const managementViews = createGroupManagementViewStore();
    const t = makeT('en');
    const { element, root } = createHostMount();
    mounted.push({ root, element, dispose: async () => { managementViews.clear(); await ctx.fiber.dispose(); } });

    actions.patchDraft(row.group.rootSessionId, (draft) => ({ ...draft, text: 'Keep draft across Manage tab' }));

    const render = async (showManage: boolean) => {
      await act(async () => {
        root.render(
          <StrictMode>
            <div data-composer-host="">
              <WorkspaceGroupComposer
                matched={{ sessionId: row.group.rootSessionId }}
                actions={actions}
                bots={botCatalog}
                managementViews={managementViews}
                onOpenSession={async () => {}}
                t={t}
              />
            </div>
            {showManage && (
              <GroupWorkspaceView
                {...({} as PropsRuntime<'conversation.view'>)}
                sessionId={row.group.rootSessionId as never}
                summary={row}
                actions={actions}
                bots={botCatalog}
                managementViews={managementViews}
                inspectCall={undefined}
                viewRequest={null}
                openView={() => {}}
                completeViewRequest={() => {}}
                t={t}
              />
            )}
          </StrictMode>,
        );
      });
    };

    await render(false);
    await vi.waitFor(() => expect(element.querySelector('[data-workspace-group-composer]')).not.toBeNull());
    expect((element.querySelector('[data-workspace-group-composer] textarea') as HTMLTextAreaElement).value).toBe('Keep draft across Manage tab');

    // Switch to Manage group: slot still elects the group root (preventing native fallback), while WorkspaceGroupComposer returns null.
    await render(true);
    expect(selectGroupComposer({ sessionId: row.group.rootSessionId as never }, actions)).toEqual({ sessionId: row.group.rootSessionId });
    expect(managementViews.isActive(row.group.rootSessionId)).toBe(true);
    expect(managementViews.isActive('other-group-session')).toBe(false);
    expect(element.querySelector('[data-workspace-group-composer]')).toBeNull();
    expect(element.querySelector('[data-composer-host]')?.innerHTML).toBe('');

    // Switch back to Chat: composer returns cleanly with its preserved draft.
    await render(false);
    expect(managementViews.isActive(row.group.rootSessionId)).toBe(false);
    await vi.waitFor(() => expect(element.querySelector('[data-workspace-group-composer]')).not.toBeNull());
    expect((element.querySelector('[data-workspace-group-composer] textarea') as HTMLTextAreaElement).value).toBe('Keep draft across Manage tab');
  });

  it.each(['en', 'zh'] as const)('renders non-duplicated permission label in GroupOverview (%s)', async (language) => {
    const ctx = new Context();
    const data = view();
    const row = summary();
    ctx.provide('remote.dshBot.groups', {
      view: async () => ({ ok: true, value: data }),
      list: async () => ({ ok: true, value: [row] }),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const t = makeT(language);
    const permSnapshot = {
      currentValue: 'workspace-write',
      catalog: { options: [{ value: 'workspace-write', name: 'Workspace Write' }] },
      catalogVersion: 1,
      loading: false,
      saving: false,
      loadError: false,
      saveError: false,
    };
    const permissionState = {
      rootSessionId: row.group.rootSessionId,
      store: {
        subscribe: () => () => {},
        getSnapshot: () => permSnapshot,
      },
      refresh: async () => {},
      select: async () => {},
      dispose: () => {},
    } as unknown as GroupPermissionState;
    const { element, root } = createHostMount();
    mounted.push({ root, element, dispose: () => ctx.fiber.dispose() });

    await act(async () => {
      root.render(<GroupOverview summary={row} actions={actions} bots={bots} permissionState={permissionState} t={t} />);
    });
    await vi.waitFor(() => expect(element.querySelector('[data-group-overview]')).not.toBeNull());
    const expected = `${t('groups.permission')}: ${t('groups.permissionWorkspaceWrite')}`;
    const doubled = `${t('groups.permissionWorkspaceWrite')}: ${t('groups.permissionWorkspaceWrite')}`;
    expect(element.textContent).toContain(expected);
    expect(element.textContent).not.toContain(doubled);
  });

  it('omits empty member action menu in GroupTurnExecution and marks Stop as danger when protocol 2', async () => {
    const ctx = new Context();
    const data = view();
    const delivery = {
      id: 'delivery-1',
      turnId: 'turn-1',
      memberId: data.members[0]!.id,
      ordinal: 0,
      bot: data.members[0]!.bot,
      botRevision: 1,
      presetId: 'bot-alpha',
      contextOutputMessageIds: [],
      contextTruncated: false,
      state: 'running' as const,
    };
    const turn = {
      id: 'turn-1',
      group: { groupId: data.group.id, groupCreatedAt: data.group.createdAt },
      operationId: 'op-1',
      requestDigest: 'digest',
      inputMessageId: 'msg-1',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      schemaVersion: 1 as const,
      membershipRevision: 1,
      orderedMemberIds: [data.members[0]!.id],
      mode: 'natural' as const,
      contextThroughSeq: 0,
      state: 'running' as const,
    };
    data.turns = [turn];
    data.deliveries = [delivery];
    const actions = createGroupActions(ctx, {});
    const botCatalog = makeBotCatalog();
    const t = makeT('en');
    const { element, root } = createHostMount();
    mounted.push({ root, element, dispose: () => ctx.fiber.dispose() });

    await act(async () => {
      root.render(
        <GroupTurnExecution
          view={data}
          turn={turn}
          actions={actions}
          bots={botCatalog}
          onOpenExecution={() => {}}
          onRequestSupplement={null}
          t={t}
        />,
      );
    });
    await click(element.querySelector('button[aria-expanded]') as HTMLButtonElement);
    expect(element.querySelector('button[aria-haspopup="menu"]')).toBeNull();

    const p2Turn = { ...turn, protocol: 2 as const };
    await act(async () => {
      root.render(
        <GroupTurnExecution
          view={{ ...data, turns: [p2Turn] }}
          turn={p2Turn}
          actions={actions}
          bots={botCatalog}
          onOpenExecution={() => {}}
          onRequestSupplement={null}
          t={t}
        />,
      );
    });
    const menuTrigger = element.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    expect(menuTrigger).not.toBeNull();
    const menuWrapper = menuTrigger?.closest('[data-menu-portal]');
    expect(menuWrapper).not.toBeNull();
    expect(menuWrapper?.hasAttribute('data-menu-autofocus')).toBe(true);
    await click(menuTrigger!);
    const stopItem = element.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(stopItem?.textContent).toBe(en.ui['execution.stopMember']);
    expect(stopItem?.hasAttribute('data-menu-danger')).toBe(true);
  });

  it('styles fallback composers and GroupSessionHover with theme tokens for light/dark themes', async () => {
    const ctx = new Context();
    const actions = createGroupActions(ctx, {});
    const botCatalog = makeBotCatalog();
    const t = makeT('en');
    const { element, root } = createHostMount();
    mounted.push({ root, element, dispose: () => ctx.fiber.dispose() });

    // WorkspaceGroupComposer fallback when group is unavailable
    await act(async () => {
      root.render(
        <WorkspaceGroupComposer
          matched={{ sessionId: 'missing-group-root' }}
          actions={actions}
          bots={botCatalog}
          onOpenSession={async () => {}}
          t={t}
        />,
      );
    });
    expect(element.querySelector('style')).not.toBeNull();
    expect(element.querySelector('section')?.className).toContain('fallbackComposer');

    // registerBotMainGuard fallback composer
    const registered: Array<{ component: (props: { matched: { botId: string }; t: PropsLocale<'dsh-bot'>['t'] }) => JSX.Element }> = [];
    const guardCtx = new Context();
    guardCtx.provide('slots', {
      inject: (_name: string, fn: () => () => void) => fn(),
      register: (_opts: unknown, component: (props: { matched: { botId: string }; t: PropsLocale<'dsh-bot'>['t'] }) => JSX.Element) => {
        registered.push({ component });
        return () => {};
      },
    } as never);
    registerBotMainGuard(guardCtx, botCatalog, () => {});
    const GuardComponent = registered[0]?.component;
    expect(GuardComponent).toBeDefined();
    await act(async () => {
      root.render(GuardComponent!({ matched: { botId: 'alpha' }, t }));
    });
    const guardSection = element.querySelector('[data-bot-main-unavailable="alpha"]');
    expect(guardSection?.className).toContain('fallbackComposer');
    expect(guardSection?.querySelector('style')).not.toBeNull();
    await guardCtx.fiber.dispose();

    // GroupSessionHover inline theme tokens
    const row = summary();
    await act(async () => {
      root.render(
        <GroupSessionHover
          sessionId={row.group.rootSessionId as never}
          useGroups={(select) => select({ groups: [row], loading: false, loaded: true, pollIntervalMs: 0 })}
          useCatalog={(select) => select(botCatalog.getSnapshot())}
          t={t}
        />,
      );
    });
    const hover = element.querySelector<HTMLElement>('[data-group-session-hover]');
    expect(hover?.style.color).toBe('var(--dsw-alias-label-primary)');
    expect(hover?.style.background).toBe('var(--dsw-alias-bg-base)');
  });

  it('removes dead single-item chat.inWorkspace menus from BotSessionsSidebar and BotsRightTab', async () => {
    const app = await mountClient([bot()], 'en', undefined, {}, undefined, true);
    try {
      await app.unmountPage();
      const sidebar = await app.mountSidebar();
      await click(button(sidebar, en.ui['sidebar.sessions']));
      expect(sidebar.querySelector(`button[aria-label="${en.ui['sidebar.moreActions'].replace('{name}', 'Alpha Bot')}"]`)).toBeNull();

      const rightTab = await app.mountRightTab();
      expect(rightTab.querySelector(`button[aria-label="${en.ui['card.more']}"]`)).toBeNull();
      expect(rightTab.textContent).not.toContain(en.ui['chat.inWorkspace']);
    } finally {
      await app.dispose();
    }
  });

  it('fixes CSS clobbering, double checkboxes, error alert tokens, coarse pointer heights, popover elevation, and duplicate CSS blocks', () => {
    const groupsCss = readFileSync('src/client/styles/groups.module.css', 'utf8');
    expect(groupsCss).toContain(':where(.panel:not(.managementPanel), .managementPanel .editor) :where(button, input, textarea, select)');
    expect(groupsCss).not.toMatch(/\.exportQueueHeader\s+input\[type="checkbox"\][^}]*appearance:\s*auto/);
    expect(groupsCss).toMatch(/\.panel\s+input\[type="checkbox"\][^{]*\{[^}]*appearance:\s*none;/s);
    expect(groupsCss).toMatch(/\.mentionMenu\s*\{[^}]*border:\s*1px solid var\(--dsw-alias-border-l3\)[^}]*box-shadow:/s);

    const groupsPanelSrc = readFileSync('src/client/components/GroupsPanel.tsx', 'utf8');
    expect(groupsPanelSrc).toMatch(/memory:\s*\{\s*icon:\s*IconDatabaseOutlineRegular/);
    expect(groupsPanelSrc).toMatch(/model:\s*\{\s*icon:\s*IconDataOutlineRegular/);

    for (const cssPath of [
      'src/client/styles/background-work.module.css',
      'src/client/styles/capabilities.module.css',
      'src/client/styles/routines.module.css',
      'src/client/proactive/follow-up.module.css',
      'src/client/proactive/responsibility.module.css',
      'src/client/proactive/workspace.module.css',
    ]) {
      const css = readFileSync(cssPath, 'utf8');
      expect(css, `${cssPath} should style [role="alert"] with --dsw-alias-state-error-primary`).toMatch(
        /\[role="alert"\][^{]*\{[^}]*color:\s*var\(--dsw-alias-state-error-primary\)/s,
      );
    }

    const detailCss = readFileSync('src/client/styles/detail.module.css', 'utf8');
    expect(detailCss).toMatch(/@media\s*\(pointer:\s*coarse\)\s*\{\s*\.page button\s*\{\s*min-height:\s*44px;/s);

    const botsCss = readFileSync('src/client/styles/bots.module.css', 'utf8');
    expect(botsCss.match(/^\.activityPreview\s*\{/gm)).toHaveLength(1);
    expect(botsCss.match(/^\.relativeTime\s*\{/gm)).toHaveLength(1);
  });
});

describe('Issue #60: accessibility and destructive confirmation modals', () => {
  it('renders TeamRecipes inside <Modal> with Escape close and confirms recipe removal', async () => {
    const data = view();
    const recipe: TeamRecipe = {
      format: 'dsh-bot-team',
      version: 1,
      name: 'Portable Team',
      mode: 'natural',
      onDemand: false,
      roles: data.members.map((member, index) => ({
        id: `role-${index}`,
        role: `Role ${index}`,
        preferredBotId: member.bot.botId,
        template: 'standard',
      })),
    };
    const preview = {
      recipe,
      roles: data.members.map((member, index) => ({
        roleId: `role-${index}`,
        bot: member.bot,
        match: 'preferred',
        capabilityMatch: true,
        candidates: bots.map((b) => ({ bot: { botId: b.id, botCreatedAt: b.createdAt }, name: b.name, template: 'standard' })),
      })),
    };
    const teamRemove = vi.fn(async () => ({ ok: true, value: undefined }));
    const remote = {
      teamList: vi.fn(async () => ({ ok: true, value: [{ id: 'saved-1', savedAt: 1, recipe }] })),
      teamCapture: vi.fn(async () => ({ ok: true, value: recipe })),
      teamPreview: vi.fn(async () => ({ ok: true, value: preview })),
      teamRemove,
    };
    const actions = { remote: () => remote } as unknown as GroupActions;
    const onClose = vi.fn();
    const t = makeT('en');
    const { element, root } = createHostMount();
    mounted.push({ root, element });

    await act(async () => {
      root.render(<TeamRecipes view={data} bots={bots} actions={actions} onSaved={async () => {}} onClose={onClose} t={t} />);
    });

    const mainDialog = element.querySelector('dialog[aria-modal="true"]');
    expect(mainDialog).not.toBeNull();
    expect(element.querySelector('section[role="dialog"]')).toBeNull();

    // Remove recipe requires confirmation modal
    await click(button(element, en.ui['teams.remove']));
    expect(teamRemove).not.toHaveBeenCalled();
    const dialogs = [...element.querySelectorAll('dialog')];
    expect(dialogs).toHaveLength(2);
    const confirmDialog = dialogs[1]!;
    expect(confirmDialog.textContent).toContain(t('teams.removeConfirm', { name: 'Portable Team' }));
    await click(button(confirmDialog, en.ui['actions.cancel']));
    expect(teamRemove).not.toHaveBeenCalled();

    // Confirm remove executes teamRemove
    await click(button(element, en.ui['teams.remove']));
    const confirmDialog2 = [...element.querySelectorAll('dialog')][1]!;
    await click(button(confirmDialog2, en.ui['teams.remove']));
    expect(teamRemove).toHaveBeenCalledExactlyOnceWith('saved-1');

    // Escape closes the TeamRecipes Modal
    await act(async () => {
      mainDialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('adds combobox ARIA, blur dismissal, and + launcher aria-expanded in GroupComposer', async () => {
    const ctx = new Context();
    const data = view();
    const row = summary();
    ctx.provide('remote.dshBot.groups', {
      view: async () => ({ ok: true, value: data }),
      list: async () => ({ ok: true, value: [row] }),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const t = makeT('en');
    const { element, root } = createHostMount();
    mounted.push({ root, element, dispose: () => ctx.fiber.dispose() });

    await act(async () => {
      root.render(
        <div>
          <button type="button" data-outside="">Outside</button>
          <GroupConversation
            workspace
            summary={row}
            actions={actions}
            bots={bots}
            expandedTurns={{}}
            onExpandTurn={() => {}}
            onOpenSession={async () => {}}
            t={t}
          />
        </div>,
      );
    });
    await vi.waitFor(() => expect(element.querySelector('textarea')).not.toBeNull());
    const textarea = element.querySelector<HTMLTextAreaElement>('textarea')!;
    const launcher = element.querySelector<HTMLButtonElement>('[data-group-command-launcher]')!;
    expect(textarea.getAttribute('role')).toBe('combobox');
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
    expect(launcher.getAttribute('aria-expanded')).toBe('false');

    // Open command menu via + launcher
    await click(launcher);
    await vi.waitFor(() => expect(element.querySelector('[data-group-command-menu]')).not.toBeNull());
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    expect(launcher.getAttribute('aria-expanded')).toBe('true');
    expect(textarea.getAttribute('aria-controls')).toBe(element.querySelector('[role="listbox"]')?.id);

    // Blur to an outside element dismisses the popup (React 18 onBlur listens to focusout).
    const outside = element.querySelector<HTMLButtonElement>('[data-outside]')!;
    await act(async () => {
      textarea.focus();
      outside.focus();
    });
    await vi.waitFor(() => expect(element.querySelector('[role="listbox"]')).toBeNull());
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
  });

  it('gives BackgroundTasksPanel radios a shared name and replaces window.confirm with Modal', async () => {
    const stopAll = vi.fn(async () => {});
    const task = {
      label: 'Worker 1',
      running: true,
      address: { childSessionId: 'child-1', mode: 'continuable' as const },
    };
    const snapshot = { loaded: true, loading: false, error: undefined, tasks: [task] };
    const actions = {
      forBot: () => ({
        catalog: { subscribe: () => () => {}, getSnapshot: () => snapshot, refresh: async () => {} },
        open: async () => {},
        stop: async () => {},
        stopAll,
        supplement: async () => {},
        dispose: () => {},
      }),
    } as unknown as BackgroundActions;
    const t = makeT('en');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { element, root } = createHostMount();
    mounted.push({ root, element });

    await act(async () => {
      root.render(<BackgroundTasksPanel bot={bot()} actions={actions} t={t} />);
    });

    // Radios share a non-empty name
    await click(button(element, en.ui['background.supplement']));
    const radios = [...element.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios[0]!.name).toBeTruthy();
    expect(radios[0]!.name).toBe(radios[1]!.name);

    // Stop all uses Modal instead of window.confirm
    await click(button(element, en.ui['background.stopAll']));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    const dialog = element.querySelector('dialog');
    expect(dialog?.textContent).toContain(en.ui['background.stopConfirm']);
    await click(button(dialog!, en.ui['actions.cancel']));
    expect(stopAll).not.toHaveBeenCalled();

    await click(button(element, en.ui['background.stopAll']));
    const dialog2 = element.querySelector('dialog')!;
    await click(button(dialog2, en.ui['background.stopAll']));
    expect(stopAll).toHaveBeenCalledOnce();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('uses Modal (not window.confirm) when deleting a skill in CapabilitiesPanel', async () => {
    const removeSkill = vi.fn(async () => {});
    const actions = {
      inspect: vi.fn(async () => ({
        kind: 'inspect',
        mainSessionId: 'main-1',
        dataFlow: { state: 'clear', reasons: [] },
        online: true,
        skillsAvailable: true,
        skills: [],
        ownSkills: ['review'],
        tools: [],
        extraDirs: [],
      })),
      readSkill: vi.fn(async () => ({ kind: 'skill', name: 'review', hash: 'h1', content: 'body' })),
      writeSkill: vi.fn(),
      removeSkill,
      freshConversation: vi.fn(),
      openConversation: vi.fn(),
    } as unknown as ModelActions;
    const t = makeT('en');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { element, root } = createHostMount();
    mounted.push({ root, element });

    await act(async () => {
      root.render(<CapabilitiesPanel expanded bot={bot()} actions={actions} t={t} />);
    });
    await click(button(element, en.ui['capabilities.edit']));
    await click(button(element, en.ui['capabilities.remove']));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(removeSkill).not.toHaveBeenCalled();
    const dialog = element.querySelector('dialog')!;
    expect(dialog.textContent).toContain(en.ui['capabilities.removeConfirm']);
    await click(button(dialog, en.ui['actions.cancel']));
    expect(removeSkill).not.toHaveBeenCalled();

    await click(button(element, en.ui['capabilities.remove']));
    await click(element.querySelector<HTMLButtonElement>('dialog [data-capability-confirm="remove-skill"]')!);
    expect(removeSkill).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'alpha-bot' }), 'review', 'h1');
  });

  it('uses SegmentedTabs in BotEditor and SharedMemoryPanel', async () => {
    const t = makeT('en');
    const { element, root } = createHostMount();
    mounted.push({ root, element });

    await act(async () => {
      root.render(
        <BotEditor
          bot={bot()}
          memoryPanel={<div data-memory-content="">Memory</div>}
          onSave={async () => {}}
          onCancel={() => {}}
          t={t}
        />,
      );
    });
    const editorTabs = [...element.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
    expect(editorTabs).toHaveLength(2);
    expect(editorTabs[0]!.getAttribute('aria-controls')).toContain('-settings-panel');
    await click(editorTabs[1]!);
    expect(element.querySelector('[data-memory-content]')).not.toBeNull();

    const select = vi.fn();
    const memorySnapshot = {
      input: { scope: 'shared' as const, view: 'facts' as const, query: '' },
      rows: [],
      total: 0,
      revision: 1,
      loaded: true,
      loading: false,
      error: undefined,
      next: undefined,
    };
    const binding = {
      catalog: {
        subscribe: () => () => {},
        getSnapshot: () => memorySnapshot,
        select,
        refresh: async () => {},
        nextPage: () => {},
      },
      remote: () => ({ cleanupStatuses: async () => ({ ok: true, value: [] }), autoShareStatus: async () => ({ ok: true, value: { enabled: false, recent: [] } }) }),
      refresh: async () => {},
    } as unknown as SharedMemoryBinding;

    await act(async () => {
      root.render(<SharedMemoryPanel binding={binding} scope="shared" botId="alpha-bot" t={t} />);
    });
    const memoryTabs = [...element.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
    expect(memoryTabs).toHaveLength(5);
    expect(memoryTabs.every((tab) => Boolean(tab.id && tab.getAttribute('aria-controls')))).toBe(true);
    await click(memoryTabs[1]!);
    expect(select).toHaveBeenCalledWith({ view: 'journal', cursor: undefined, revision: undefined });
  });

  it('requires confirmation modal to archive a group in GroupOverview and GroupsPanel, and adds Cancel to RoutinePanel delete modal', async () => {
    const ctx = new Context();
    const data = view();
    const row = summary();
    const archive = vi.fn(async () => ({ ok: true, value: { ...data.group, archived: true } }));
    ctx.provide('remote.dshBot.groups', {
      view: async () => ({ ok: true, value: data }),
      list: async () => ({ ok: true, value: [row] }),
      archive,
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const t = makeT('en');
    const { element, root } = createHostMount();
    mounted.push({ root, element, dispose: () => ctx.fiber.dispose() });

    // GroupOverview archive confirmation + danger menu items
    await act(async () => {
      root.render(<GroupOverview summary={row} actions={actions} bots={bots} t={t} />);
    });
    await vi.waitFor(() => expect(element.querySelector('[data-group-overview]')).not.toBeNull());
    await click(button(element, en.ui['card.more']));
    const archiveMenuItem = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.textContent === en.ui['groups.archive']);
    const deleteMenuItem = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.textContent === en.ui['groups.delete']);
    expect(archiveMenuItem?.hasAttribute('data-menu-danger')).toBe(true);
    expect(deleteMenuItem?.hasAttribute('data-menu-danger')).toBe(true);
    await click(archiveMenuItem!);
    expect(archive).not.toHaveBeenCalled();
    const overviewDialog = element.querySelector('dialog')!;
    expect(overviewDialog.textContent).toContain(t('groups.archiveConfirm', { name: data.group.name }));
    await click(button(overviewDialog, en.ui['actions.cancel']));
    expect(archive).not.toHaveBeenCalled();

    await click(button(element, en.ui['card.more']));
    await click(button(element, en.ui['groups.archive']));
    await click(button(element.querySelector('dialog')!, en.ui['groups.archive']));
    expect(archive).toHaveBeenCalledOnce();

    // Non-workspace GroupConversation archive confirmation
    archive.mockClear();
    await act(async () => {
      root.render(
        <GroupConversation
          workspace={false}
          summary={row}
          actions={actions}
          bots={bots}
          expandedTurns={{}}
          onExpandTurn={() => {}}
          onOpenSession={async () => {}}
          t={t}
        />,
      );
    });
    await vi.waitFor(() => expect(button(element, en.ui['groups.archive'])).toBeTruthy());
    await click(button(element, en.ui['groups.archive']));
    expect(archive).not.toHaveBeenCalled();
    const convDialog = element.querySelector('dialog')!;
    await click(button(convDialog, en.ui['actions.cancel']));
    expect(archive).not.toHaveBeenCalled();
    await click(button(element, en.ui['groups.archive']));
    await click(button(element.querySelector('dialog')!, en.ui['groups.archive']));
    expect(archive).toHaveBeenCalledOnce();

    // RoutinePanel delete modal has a Cancel button
    const removeRoutine = vi.fn(async () => {});
    const routineRecord = {
      id: 'routine-1',
      botId: 'alpha-bot',
      sessionId: 'session-1',
      title: 'Daily digest',
      prompt: 'Summarize updates',
      kind: 'every' as const,
      everySeconds: 3600,
      status: 'active' as const,
      scheduledAt: '2026-11-26T10:00:00.000Z',
    };
    const routineSnapshot = {
      loaded: true,
      error: undefined,
      nativeAvailable: true,
      routines: [routineRecord],
      legacy: [],
      legacyUnavailable: false,
      legacySkipped: 0,
    };
    const historySnapshot = { loaded: true, records: [], error: undefined, unavailable: false, more: false };
    const routineActions = {
      catalog: {
        subscribe: () => () => {},
        getSnapshot: () => routineSnapshot,
        refresh: async () => {},
      },
      remove: removeRoutine,
      deleteLegacy: vi.fn(),
      runNow: vi.fn(),
      update: vi.fn(),
      history: () => ({ subscribe: () => () => {}, getSnapshot: () => historySnapshot, loadMore: async () => {}, dispose: () => {} }),
    } as unknown as RoutineActions;
    await act(async () => {
      root.render(<RoutinePanel actions={routineActions} bots={[bot()]} botId="alpha-bot" onOpenSession={async () => {}} t={t} />);
    });
    await click(button(element, en.ui['actions.delete']));
    const routineDialog = element.querySelector('dialog')!;
    await click(button(routineDialog, en.ui['actions.cancel']));
    expect(element.querySelector('dialog')).toBeNull();
    expect(removeRoutine).not.toHaveBeenCalled();
  });
});

describe('Issue #60: i18n formatting, enums, and copy parity', () => {
  it('formats lists, dates, numbers, relative time, and group preset names cleanly per locale', () => {
    expect(formatList(['Alpha', 'Beta'], 'en')).toBe(new Intl.ListFormat('en', { style: 'short', type: 'conjunction' }).format(['Alpha', 'Beta']));
    expect(formatList(['Alpha', 'Beta'], 'zh-CN')).toBe(new Intl.ListFormat('zh-CN', { style: 'short', type: 'conjunction' }).format(['Alpha', 'Beta']));
    expect(formatList(['Alpha', 'Beta'], 'en')).not.toContain('、');
    expect(resolveLocale('activity.locale')).toBeUndefined();
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(() => formatDateTime(Date.UTC(2026, 10, 26, 12, 0), 'activity.locale')).not.toThrow();
    expect(() => formatNumber(1234.5, 'activity.locale')).not.toThrow();

    const now = 1_700_000_000_000;
    expect(relativeTime(now, 'zh-CN', now)).toBe('刚刚');
    expect(relativeTime(now - 30_000, 'zh-CN', now)).toBe('刚刚');
    expect(relativeTime(now, 'zh', now)).toBe('刚刚');
    expect(relativeTime(now, 'en', now)).toBe(new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' }).format(0, 'second'));

    expect(groupRootPresetName('en-US')).toBe(en.ui['groups.presetName']);
    expect(groupRootPresetName('zh-CN')).toBe(zh.ui['groups.presetName']);
    expect(groupRootPresetName('en-US')).not.toContain('/');
    expect(groupRootPresetName('zh-CN')).not.toContain('/');
  });

  it('localizes notification channels, connector transports, and replyTo labels while preserving wire values', async () => {
    const tZh = makeT('zh');
    const savePolicy = vi.fn(async (policy) => ({ ...policy, revision: 1, createdAt: 1, updatedAt: 1, schemaVersion: 1, scopeDigest: 'scope', targetDigest: 'in-app' }));
    const integrationsSnapshot = {
      loaded: true,
      loading: false,
      error: undefined,
      imSupported: true,
      desktopSupported: false,
      defaults: { dailyLimit: 20, cooldownSec: 60 },
      definitions: [],
      assignments: [],
      policies: [
        {
          id: 'pol-1',
          owner: { botId: 'alpha-bot', botCreatedAt: 1 },
          channel: 'in-app' as const,
          enabled: true,
          timezone: 'UTC',
          dailyLimit: 20,
          cooldownSec: 60,
          authorization: { mode: 'ask' as const },
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          schemaVersion: 1 as const,
          scopeDigest: 'scope',
          targetDigest: 'in-app',
        },
      ],
      notifications: [],
    };
    const integrations = {
      catalog: {
        subscribe: () => () => {},
        getSnapshot: () => integrationsSnapshot,
        refresh: async () => {},
      },
      write: async <T,>(fn: () => Promise<T>) => fn(),
      notifications: () => ({ savePolicy, test: vi.fn(), markRead: vi.fn() }),
      connectors: () => ({ saveDefinition: vi.fn(), saveAssignment: vi.fn(), apply: vi.fn() }),
      credentials: () => undefined,
    } as unknown as IntegrationActions;
    const { element, root } = createHostMount();
    mounted.push({ root, element });

    await act(async () => {
      root.render(<NotificationsPanel actions={integrations} bots={[bot()]} onOpenSession={async () => {}} t={tZh} />);
    });
    await click(button(element, zh.ui['notifications.policies']));
    expect(element.textContent).toContain(zh.ui['notifications.channel.in-app']);
    await click(button(element, zh.ui['notifications.newPolicy']));
    const channelSelect = [...element.querySelectorAll('select')].find((select) => [...select.options].some((o) => o.value === 'in-app'))!;
    expect([...channelSelect.options].map((o) => [o.value, o.textContent])).toEqual([
      ['in-app', zh.ui['notifications.channel.in-app']],
      ['im', zh.ui['notifications.channel.im']],
    ]);

    await act(async () => {
      root.render(
        <ConnectorEditor
          actions={integrations}
          active
          busy={false}
          perform={async (fn) => { await fn(); }}
          onCancel={() => {}}
          t={tZh}
        />,
      );
    });
    const transportSelect = [...element.querySelectorAll('select')][1]!;
    expect([...transportSelect.options].map((o) => [o.value, o.textContent])).toEqual([
      ['streamable-http', zh.ui['connectors.transport.streamable-http']],
      ['stdio', zh.ui['connectors.transport.stdio']],
    ]);

    await act(async () => {
      root.render(
        <MessageCard
          node={{
            key: 'k1',
            id: 'm1',
            kind: 'dsh-bot-message',
            target: 'chat',
            anchorSeq: 1,
            location: { kind: 'unresolved' },
            visibility: 'visible',
            data: {
              source: {
                kind: 'dsh-bot-message',
                direction: 'received',
                mode: 'reply',
                priority: 'normal',
                from: { botId: 'alpha', botCreatedAt: 1 },
                to: { botId: 'beta', botCreatedAt: 1 },
                threadId: 'thread-12345678',
                replyTo: 'origin-87654321',
                requestId: 'req-1',
                displaySnapshots: { from: { name: 'Alpha' }, to: { name: 'Beta' } },
              },
              text: 'Hello back',
              time: 1_700_000_000_000,
            },
          } as never}
          t={tZh}
        />,
      );
    });
    await click(element.querySelector('button[aria-expanded]') as HTMLButtonElement);
    expect(element.textContent).toContain(`${zh.ui['messages.replyTo']}: origin-8`);
    expect(element.textContent).not.toContain('replyTo:');
  });

  it('maintains EN/ZH parity, resolves ZH 资料 collision, aligns semantic drifts, and removes Supergroup codename from user-facing copy', () => {
    expect(Object.keys(en.ui).sort()).toEqual(Object.keys(zh.ui).sort());
    expect(zh.ui['groups.export.receipt.preferenceFailed']).toContain('不要重发');
    expect(en.ui['groups.mentionRequired']).toContain('round');
    expect(zh.ui['groups.mentionRequired']).toContain('开始一轮');
    expect(en.ui['simple.automaticTeam']).not.toMatch(/Supergroup/i);
    expect(zh.ui['simple.automaticTeam']).not.toMatch(/Supergroup/i);
    expect(en.config.supergroup.$description).not.toMatch(/Supergroup/i);
    expect(zh.config.supergroup.$description).not.toMatch(/Supergroup/i);

    // Three-way "资料" collision resolved into distinct ZH labels
    expect(new Set([zh.ui['chat.profile'], zh.ui['memory.kindProfile'], zh.ui['botMode.materials']]).size).toBe(3);
    expect(zh.ui['chat.profile']).not.toBe('资料');
    expect(zh.ui['memory.kindProfile']).not.toBe('资料');
    expect(zh.ui['botMode.materials']).not.toBe('资料');

    // No hardcoded Chinese list joins remain in client components
    for (const file of [
      'src/client/components/GroupsPanel.tsx',
      'src/client/components/GroupExportQueue.tsx',
      'src/client/components/GroupExportReview.tsx',
      'src/client/components/MemberRemovalDialog.tsx',
      'src/client/components/RosterManagement.tsx',
      'src/client/components/TeamRecipes.tsx',
    ]) {
      expect(readFileSync(file, 'utf8'), `${file} must not hardcode join('、')`).not.toContain("join('、')");
    }
  });
});
