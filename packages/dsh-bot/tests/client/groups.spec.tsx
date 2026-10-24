// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { bot, button, click, field, fill, mountClient } from './helpers.js';
import type { GroupSessionBadgeInjected } from '../../src/client/components/GroupSessionBadge.js';
import { GROUP_ROOT_PRESET, groupTurnSchema, type GroupView } from '../../src/shared/groups.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
const bots = [bot({id:'alpha',name:'Same name',avatarVariant:'glasses',avatarColor:'teal'}),bot({id:'beta',name:'Same name',avatarVariant:'spout',avatarColor:'rose'})];
function view(): GroupView {
  const group: GroupView['group'] = { id:'group:one',operationId:'create:one',createDigest:'hash',name:'Synthetic group',rootSessionId:'group-root-one',rootPresetId:GROUP_ROOT_PRESET,cwd:'/synthetic',mode:'mention' as const,membershipRevision:1,revision:1,archived:false,state:'ready' as const,createdAt:1,updatedAt:1,schemaVersion:1 as const };
  const key = {groupId:group.id,groupCreatedAt:1};
  return { group,unread:false,readRevision:0,members:bots.map((b,order) => ({id:`member:${b.id}`,group:key,bot:{botId:b.id,botCreatedAt:b.createdAt},order,joinedAt:1,enabled:true})),unavailableMemberIds:[],running:false,turns:[],deliveries:[],messages:[{id:'historic-beta',seq:1,at:1,text:'Historic reply',turnId:'turn:old',speaker:{bot:{botId:'beta',botCreatedAt:1},name:'Original beta',avatarColor:'rose',avatarVariant:'spout'}}],hasEarlier:false };
}
function summary() { const { turns: _t, deliveries: _d, messages: _m, hasEarlier: _h, ...s } = view(); return s; }
function configure(remote: Parameters<NonNullable<Parameters<typeof mountClient>[2]>>[0]) { remote.data.groupView = view(); remote.data.groups = [summary()]; }
describe('U08 real public slots / Remote-double group UI', () => {
  it.each(['en','zh'] as const)('%s preserves message nodes, scroll, focus, selection and drafts across refresh and errors', async lang => {
    const app = await mountClient(bots,lang,configure); const t = (lang === 'en' ? en : zh).ui;
    try {
      await click(button(app.container,t['groups.title']));
      await vi.waitFor(() => expect(app.container.textContent).toContain('Historic reply'));
      const draft = field(app.container,t['groups.message']) as HTMLTextAreaElement;
      await fill(draft,'Draft stays'); draft.focus(); draft.setSelectionRange(2,6);
      const timeline = app.container.querySelector('[role="log"]') as HTMLDivElement; timeline.scrollTop = 40;
      const message = app.container.querySelector('[data-group-message="historic-beta"]');
      expect(message?.querySelector('[data-avatar-variant="spout"][data-avatar-color="rose"]')).toBeTruthy();
      const reads = app.remote.groups.view.mock.calls.length;
      await act(async () => { await app.ctx.emit('connection/reset'); });
      await vi.waitFor(() => expect(app.remote.groups.view.mock.calls.length).toBeGreaterThan(reads));
      expect(field(app.container,t['groups.message'])).toBe(draft); expect(draft.value).toBe('Draft stays'); expect(document.activeElement).toBe(draft); expect(draft.selectionStart).toBe(2); expect(timeline.scrollTop).toBe(40); expect(app.container.querySelector('[data-group-message="historic-beta"]')).toBe(message);
      app.remote.groups.view.mockRejectedValueOnce(new Error('network gone'));
      await act(async () => { await app.ctx.emit('connection/reset'); });
      await vi.waitFor(() => expect(app.container.textContent).toContain(t['groups.disconnected'])); expect(draft.value).toBe('Draft stays'); expect(message?.isConnected).toBe(true);
      const current = app.remote.data.groupView; if (!current) throw new Error(); app.remote.data.records = [bots[0] as typeof bots[number]];
      app.remote.data.groupView = {...current,members:current.members.map(m => m.bot.botId === 'beta' ? {...m,enabled:false,removedAt:10} : m)};
      await act(async () => { await app.ctx.emit('connection/reset'); });
      expect(app.container.textContent).toContain('Original beta'); expect(message?.querySelector('[data-avatar-variant="spout"]')).toBeTruthy();
    } finally { await app.dispose(); }
  });
  it('creates from distinct birthday keys and confirms history, routes exact @ tokens, retains request ID on an uncertain retry', async () => {
    const app = await mountClient(bots); const t = en.ui;
    try {
      await click(button(app.container,t['groups.title'])); await click(button(app.container,t['groups.create']));
      await fill(field(app.container,t['groups.name']),'Synthetic group');
      const form = app.container.querySelector('form[aria-label="Create group"]'); if (!form) throw new Error();
      const members = [...form.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];
      await click(members[0] as HTMLInputElement); await click(members[1] as HTMLInputElement); await click(field(form,t['groups.historyConsent']));
      app.remote.groups.create.mockImplementation(async input => { expect(input.members).toEqual(bots.map(b => ({botId:b.id,botCreatedAt:b.createdAt}))); app.remote.data.groups = [summary()]; app.remote.data.groupView = view(); return {ok:true,value:view().group}; });
      await act(async () => { form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); }); await vi.waitFor(() => expect(app.container.textContent).toContain('Historic reply'));
      const draft = field(app.container,t['groups.message']); await fill(draft,'@Same name is text only'); await click(button(app.container,t['groups.send'])); expect(app.remote.groups.send).not.toHaveBeenCalled(); expect(app.container.textContent).toContain(t['groups.ambiguousMention']);
      await act(async () => { draft.dispatchEvent(new KeyboardEvent('keydown',{key:'@',bubbles:true})); });
      const picker = app.container.querySelector('fieldset'); if (!picker) throw new Error();
      const recipients = picker.querySelectorAll<HTMLInputElement>('input'); await click(recipients[1] as HTMLInputElement);
      await click(button(picker,t['groups.close'])); expect(document.activeElement).toBe(draft);
      app.remote.groups.send.mockResolvedValue({ok:false,error:new RemoteError('dsh-bot/recovery-needed','',{})});
      await click(button(app.container,t['groups.send'])); expect((draft as HTMLTextAreaElement).value).toBe('@Same name is text only');
      const first = app.remote.groups.send.mock.calls[0]?.[1]; expect(first?.memberIds).toEqual(['member:beta']);
      const current = app.remote.data.groupView; if (!current) throw new Error();
      app.remote.data.groupView = {...current,group:{...current.group,membershipRevision:2}};
      await act(async () => { await app.ctx.emit('connection/reset'); });
      await click(button(app.container,t['groups.send'])); expect(app.remote.groups.send.mock.calls[1]?.[1].operationId).toBe(first?.operationId);
      expect(app.remote.groups.send.mock.calls[1]?.[1].expectedMembershipRevision).toBe(1);
      await act(async () => { draft.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); }); expect(document.activeElement).toBe(draft);
      let accept!: (result: Awaited<ReturnType<typeof app.remote.groups.send>>) => void;
      app.remote.groups.send.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
      await click(button(app.container,t['groups.send'])); await fill(draft,'New draft typed during send');
      const request = app.remote.groups.send.mock.calls.at(-1)?.[1];
      await act(async () => accept({ok:true,value:groupTurnSchema.parse({id:'turn:ack',group:{groupId:'group:one',groupCreatedAt:1},operationId:request?.operationId,requestDigest:'h',inputMessageId:'input',createdAt:1,updatedAt:1,revision:1,schemaVersion:1,membershipRevision:1,orderedMemberIds:['member:beta'],mode:'mention',contextThroughSeq:1,state:'accepted'})}));
      expect((draft as HTMLTextAreaElement).value).toBe('New draft typed during send');

    } finally { await app.dispose(); }
  });
  it.each(['en', 'zh'] as const)('%s resolves typed names and reports unknown mentions without sending', async language => {
    const named = [bot({ id: 'alpha', name: '研究员' }), bot({ id: 'beta', name: 'Research Assistant' })];
    const app = await mountClient(named, language, configure);
    const t = (language === 'en' ? en : zh).ui;
    try {
      await click(button(app.container, t['groups.title']));
      await vi.waitFor(() => expect(app.container.textContent).toContain('Historic reply'));
      const draft = field(app.container, t['groups.message']);
      for (const [text, id] of [['@研究员 请分析', 'member:alpha'], ['@research ASSISTANT please help', 'member:beta']]) {
        await fill(draft, text as string);
        app.remote.groups.send.mockResolvedValue({ ok: false, error: new RemoteError('dsh-bot/recovery-needed', '', {}) });
        await click(button(app.container, t['groups.send']));
        expect(app.remote.groups.send.mock.calls.at(-1)?.[1].memberIds).toEqual([id]);
      }
      const calls = app.remote.groups.send.mock.calls.length;
      await fill(draft, '@missing Please help');
      await click(button(app.container, t['groups.send']));
      expect(app.remote.groups.send).toHaveBeenCalledTimes(calls);
      expect(app.container.textContent).toContain(t['groups.unknownMention']);
      expect(draft.value).toBe('@missing Please help');
      await fill(draft, '@研究员 @missing Please help');
      await click(button(app.container, t['groups.send']));
      expect(app.remote.groups.send.mock.calls.at(-1)?.[1].memberIds).toEqual(['member:alpha']);
      expect(app.container.textContent).toContain(t['groups.unknownMention']);
      expect(app.container.querySelector('[data-group-session-leading]')).toBeNull();
    } finally { await app.dispose(); }
  });
  it('navigates from the native root header to the exact group and persists only visible read receipts', async () => {
    const app = await mountClient(bots,'en',remote => { configure(remote); if (remote.data.groupView) remote.data.groupView.unread = true; remote.groups.markRead.mockImplementation(async (_key,_seq,revision) => { if (remote.data.groupView) remote.data.groupView = {...remote.data.groupView,unread:false,readRevision:revision + 1}; return {ok:true,value:true}; }); });
    try {
      expect(app.remote.groups.markRead).not.toHaveBeenCalled();
      const entry = app.core.entries('conversation.session.header.utilities').find(e => e.options.id === 'dsh-bot-group');
      const actions = entry?.inject?.() as unknown as GroupSessionBadgeInjected;
      await act(async () => actions.onOpenGroup('group:one'));
      await vi.waitFor(() => expect(app.container.textContent).toContain('Historic reply'));
      expect(app.selectPanel).toHaveBeenCalledWith('dsh-bot');
      await vi.waitFor(() => expect(app.remote.groups.markRead).toHaveBeenCalledWith({groupId:'group:one',groupCreatedAt:1},1,0));
      expect(app.remote.groups.send).not.toHaveBeenCalled();
    } finally { await app.dispose(); }
  });
  it('retains the edit revision during background updates and sends native child cancellation with CAS', async () => {
    const app = await mountClient(bots,'en',configure); const t = en.ui;
    try {
      await click(button(app.container,t['groups.title'])); await vi.waitFor(() => expect(app.container.textContent).toContain('Historic reply'));
      await click(button(app.container,t['groups.edit'])); const form = app.container.querySelector('form[aria-label="Edit group members"]'); if (!form) throw new Error();
      await fill(field(form,t['groups.name']),'Keep edit draft'); await click(field(form,t['groups.historyConsent']));
      const old = app.remote.data.groupView; if (!old) throw new Error();
      app.remote.data.groupView = {...old,group:{...old.group,revision:8,membershipRevision:5}};
      await act(async () => { await app.ctx.emit('connection/reset'); });
      app.remote.groups.edit.mockResolvedValue({ok:false,error:new RemoteError('dsh-bot/conflict','',{})}); await act(async () => { form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); });
      expect(app.remote.groups.edit.mock.calls[0]?.[1]).toMatchObject({name:'Keep edit draft',expectedRevision:1,expectedMembershipRevision:1});
      expect(field(form,t['groups.name']).value).toBe('Keep edit draft');
      await click(button(form,t['groups.close']));
      const turn = {id:'turn:one',group:{groupId:old.group.id,groupCreatedAt:1},operationId:'send:one',requestDigest:'h',inputMessageId:'input',createdAt:1,updatedAt:1,revision:7,schemaVersion:1 as const,membershipRevision:1,orderedMemberIds:['member:alpha'],mode:'mention' as const,contextThroughSeq:1,state:'running' as const};
      app.remote.data.groupView = {...old,turns:[turn],running:true};
      await act(async () => { await app.ctx.emit('connection/reset'); });
      await vi.waitFor(() => expect(app.container.textContent).toContain(t['groups.cancelTurn']));
      app.remote.groups.cancel.mockResolvedValue({ok:true,value:{...turn,state:'cancelled'}}); await click(button(app.container,t['groups.cancelTurn']));
      expect(app.remote.groups.cancel).toHaveBeenCalledWith(turn.group,turn.id,7);
    } finally { await app.dispose(); }
  });
});
