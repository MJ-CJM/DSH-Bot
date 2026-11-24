import { expect, it } from 'vitest';
import { hasExplicitBotAddress, matchAddressedBot, matchGroupAddress } from '../src/shared/addressed-bot.js';

const jarvis = { name: 'Jarvis' };
it.each(['你问下 Jarvis 最近有和这个相关的吗？', '请你帮我问一下 Jarvis：最近有和这个相关的吗？',
  '问Jarvis最近有和这个相关的吗？', 'Ask @jarvis: 最近有和这个相关的吗？', '@Jarvis 最近有和这个相关的吗？'])(
  'resolves a direct question without including the addressing words: %s', text => {
    expect(matchAddressedBot(text, [jarvis])).toEqual({ kind: 'match', bot: jarvis, question: '最近有和这个相关的吗？' });
  });
it.each(['不用问 Jarvis 最近做什么', '他说“问 Jarvis”，是什么意思？', 'Jarvis 可能知道', 'ask JarvisExtra about it'])(
  'does not treat mention, negation, or a different name as authority: %s', text => {
    expect(matchAddressedBot(text, [jarvis])).toBeUndefined();
  });
it('rejects ambiguous names, absent question and multi-target asks', () => {
  expect(matchAddressedBot('问 Jarvis 查到什么', [jarvis, { name: 'JARVIS' }])).toEqual({ kind: 'ambiguous' });
  expect(matchAddressedBot('问 Jarvis', [jarvis])).toEqual({ kind: 'ambiguous' });
  expect(matchAddressedBot('问 Jarvis 和 deep 有什么意见', [jarvis, { name: 'deep' }])).toEqual({ kind: 'ambiguous' });
});

it('distinguishes an explicit unavailable addressee from a conversational question', () => {
  for (const text of ['@离职的助手 请回答', '问下 Unknown 查到什么', '请问 不存在：能回答吗？'])
    expect(hasExplicitBotAddress(text)).toBe(true);
  for (const text of ['问一下这个问题', '请问 SQL 是什么', 'ask a question'])
    expect(hasExplicitBotAddress(text)).toBe(false);
});

it('only allows current members as @ addressees while retaining outside questions by name', () => {
  const member = { id: 'assistant', name: '通用助手' }, directory = [jarvis, member];
  const parse = (text: string) => matchGroupAddress(text, directory, undefined, [member]);
  for (const text of ['@Jarvis 最近的结果', '＠Ｊａｒｖｉｓ question', '问@Jarvis 进展', '让 通用助手 去问＠Jarvis 进展',
    '让 @Jarvis 问 通用助手 进展', '@assistant ask @Jarvis 进展']) {
    expect(parse(text)).toEqual({ kind: 'nonmember-mention' });
  }
  for (const text of ['@通用助手 问 Jarvis 进展', '＠ＡＳＳＩＳＴＡＮＴ ask Jarvis 进展', '让 @assistant 去问 Jarvis 进展', 'Have 通用助手 ask Jarvis 进展']) {
    expect(parse(text)).toEqual({ kind: 'match', via: member, bot: jarvis, question: '进展' });
  }
  expect(parse('问 Jarvis 进展')).toEqual({ kind: 'match', bot: jarvis, question: '进展' });
  expect(parse('@everyone 大家好')).toBeUndefined();
  const sameName = { id: 'member', name: 'Jarvis' };
  expect(matchGroupAddress('@Jarvis 进展', [jarvis, sameName], undefined, [sameName])).toMatchObject({ bot: sameName });
});
