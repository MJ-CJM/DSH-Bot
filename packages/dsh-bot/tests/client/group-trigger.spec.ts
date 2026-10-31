import { describe, expect, it, vi } from 'vitest';
import { createGroupTrigger } from '../../src/client/group-trigger.js';
import { reconcileMentionBindings, resolveGroupMentions } from '../../src/client/group-mentions.js';
const targetA = { id: 'member-a', name: '研究员', botId: 'research' }, targetB = { id: 'member-b', name: '研究员', botId: 'review' };
const targets = [{ id: 'member-a', name: '研究员', botId: 'research' }, { id: 'member-b', name: '研究员', botId: 'review' }];
describe('real rc.2 public InputTriggerController isolated bridge', () => {
  it('picks stable identities at inline caret, handles Tab, IME and disposal without sharing controllers', async () => {
    const insert = vi.fn(() => true), bridge = createGroupTrigger('group-root-spike', () => targets, insert);
    const other = createGroupTrigger('other', () => targets, vi.fn(() => true));
    bridge.track('hello @研', 8, 1);
    await vi.waitFor(() => expect(bridge.controller.menu.getSnapshot().groups[0]?.status).toBe('ready'));
    expect(bridge.controller.menu.getSnapshot().groups[0]?.items).toHaveLength(2);
    expect(other.controller.menu.getSnapshot().open).toBe(false);
    expect(bridge.controller.arbitrate('enter', true)).toBe('pass'); expect(insert).not.toHaveBeenCalled();
    expect(bridge.controller.arbitrate('tab', false)).toBe('pick-highlighted');
    expect(insert).toHaveBeenCalledWith({ start: 6, end: 8, draftRev: 1 }, 'member-a', '@研究员 ');
    bridge.dispose(); other.dispose();
    bridge.track('@', 1, 2); expect(bridge.controller.menu.getSnapshot().open).toBe(false);
  });
  it('retains identity on rename, rejects removed generations, and clears edited identities', () => {
    const binding = { start: 0, end: 4, text: '@研究员', memberId: 'member-a' };
    expect(resolveGroupMentions('@研究员 hello', [{ ...targetA, name: 'renamed' }], [], [binding]).memberIds).toEqual(['member-a']);
    expect(resolveGroupMentions('@研究员 hello', [targetB], [], [binding]).issues).toHaveLength(1);
    expect(reconcileMentionBindings('@研究员 hello', 'prefix @研究员 hello', [binding])[0]?.start).toBe(7);
    const edited = reconcileMentionBindings('@研究员 hello', '@研 hello', [binding]);
    expect(edited[0]?.start).toBe(-1);
    expect(resolveGroupMentions('no mention', targets, [], edited).memberIds).toEqual([]);
    const undone = reconcileMentionBindings('@研 hello', '@研究员 hello', edited);
    expect(resolveGroupMentions('@研究员 hello', [targetB], [], undone).issues).toHaveLength(1);
    expect(resolveGroupMentions('email a@research.com\n```\n@research\n```\n> @review\n`@research`', targets).memberIds).toEqual([]);
    expect(resolveGroupMentions('Hi @everyone', targets).memberIds).toEqual(['member-a', 'member-b']);
  });
});
