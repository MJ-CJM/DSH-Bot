import { describe, expect, it } from 'vitest';
import { resolveGroupMentions } from '../src/client/group-mentions.js';
const targets = [
  { id: 'member:cn', name: '研究员', botId: 'researcher' },
  { id: 'member:space', name: 'Research Assistant', botId: 'assistant' },
  { id: 'member:duplicate1', name: '重名 Bot', botId: 'one' },
  { id: 'member:duplicate2', name: '重名 Bot', botId: 'two' },
];
describe('typed group mentions resolve against the current membership', () => {
  it.each([
    ['@研究员 请分析', ['member:cn']],
    ['@research assistant please help', ['member:space']],
    ['@RESEARCHER, @研究员', ['member:cn']],
    ['@Research Assistant。谢谢', ['member:space']],
    ['Email user@example.com', []],
  ])('resolves %s to stable membership IDs', (text, memberIds) => {
    expect(resolveGroupMentions(text, targets)).toEqual({ memberIds, issues: [] });
  });
  it('reports missing and duplicate names without silently selecting a recipient', () => {
    expect(resolveGroupMentions('@missing hello', targets)).toMatchObject({ memberIds: [], issues: [{ reason: 'unknown' }] });
    expect(resolveGroupMentions('@重名 Bot hello', targets)).toMatchObject({ memberIds: [], issues: [{ reason: 'ambiguous' }] });
    expect(resolveGroupMentions('@重名 Bot hello', targets, ['member:duplicate2'])).toEqual({ memberIds: ['member:duplicate2'], issues: [] });
  });
  it('prefers a complete longer name and rejects stale targets', () => {
    const overlapping = [...targets, { id: 'short', name: 'Research', botId: 'short' }];
    expect(resolveGroupMentions('@Research Assistant hello', overlapping).memberIds).toEqual(['member:space']);
    expect(resolveGroupMentions('@研究员 hi', targets.filter(t => t.id !== 'member:cn')).issues).toHaveLength(1);
  });
});
