import { describe, expect, it } from 'vitest';
import { addressedPeerTask } from '../src/host/supergroup/peer-task.js';

const bots = [{ id: 'bot-a', name: 'craft' }, { id: 'bot-b', name: '研究员' }, { id: 'bot-c', name: 'Jarvis' }];
describe('user-directed peer text', () => {
  it.each([
    ['让研究员查一下公共接口', 'bot-b', '查一下公共接口'],
    ['请问 Jarvis：支持分页吗？这是另一个私人话题。', 'bot-c', '支持分页吗？'],
    ['告诉研究员：「第一项，第二项」\n这是留给 craft 的备注', 'bot-b', '第一项，第二项'],
    ['Ask Jarvis: what is the public API? My private note follows.', 'bot-c', 'what is the public API?'],
    ['请问一位合适的 Bot：什么是游标？', 'bot-b', '什么是游标？'],
    ['我的私人备注。你知道研究员擅长做什么吗？你问下他。', 'bot-b', '你知道研究员擅长做什么吗？'],
  ])('selects only the addressed question in %s', (input, id, text) => {
    expect(addressedPeerTask(input!, id!, bots)).toBe(text);
  });
  it.each([
    ['请问 Jarvis：「查一下 X」。这是我和 craft 的私聊', 'bot-b'],
    ['我和研究员聊过私人问题', 'bot-b'],
    ['不要问 Jarvis：这个问题属于我', 'bot-c'],
    ['Ask JarvisExtra: what is the password?', 'bot-c'],
    ['请问 Jarvis：「未结束的引号', 'bot-c'],
    ['请问 Jarvis：ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'bot-c'],
  ])('does not grant the target access to %s', (input, id) => {
    expect(addressedPeerTask(input!, id!, bots)).toBeUndefined();
  });
  it('requires an unambiguous live directory identity', () => {
    expect(addressedPeerTask('请问 Jarvis：任务是什么？', 'bot-c', [...bots, { id: 'other', name: 'Jarvis' }])).toBeUndefined();
    expect(addressedPeerTask('What is planning?你问下他。', 'ann', [{ id: 'ann', name: 'Ann' }])).toBeUndefined();
  });
});
