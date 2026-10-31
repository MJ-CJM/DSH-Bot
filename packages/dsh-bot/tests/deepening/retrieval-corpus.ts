/** Curated synthetic questions. Gold labels are independent of the lexical scorer. */
export const topics = [
  { id: 'coffee', content: 'I drink black coffee without sugar every morning.', distractor: 'black coffee machine cleaning guide',
    exact: 'black coffee', synonym: 'unsweetened caffeine', colloquial: '早上那杯啥都不加的喝啥', cross: '不加糖的黑咖啡', broad: 'coffee' },
  { id: 'commute', content: '我平时骑自行车通勤，下雨就坐地铁。', distractor: '自行车维修与地铁线路图',
    exact: '自行车通勤', synonym: '脚踏车上班', colloquial: '下雨咋去公司呀', cross: 'rainy day commute', broad: '地铁' },
  { id: 'diet', content: 'I eat a vegan diet and avoid all dairy products.', distractor: 'vegan diet recipe catalogue',
    exact: 'vegan diet', synonym: 'plant based meals', colloquial: 'dairy products 我能吃不', cross: '纯素饮食', broad: 'vegan' },
  { id: 'reading', content: '我睡前爱读科幻小说，周末读历史书。', distractor: '科幻小说排行榜与历史书促销',
    exact: '科幻小说', synonym: '科学幻想文学', colloquial: '睡前爱读啥呀', cross: 'bedtime science fiction', broad: '小说' },
  { id: 'meeting', content: 'Please schedule meetings after lunch at two in the afternoon.', distractor: 'schedule meetings template',
    exact: 'schedule meetings', synonym: 'post meridiem appointments', colloquial: 'meetings 啥时候方便', cross: '下午两点开会', broad: 'meetings' },
  { id: 'travel', content: '我旅行喜欢坐火车，出差也优先选高铁。', distractor: '火车模型展览和高铁建设新闻',
    exact: '喜欢坐火车', synonym: '铁路出行优先', colloquial: '出差也优先选啥', cross: 'prefer train travel', broad: '高铁' },
  { id: 'editor', content: 'My preferred editor is Visual Studio Code with Vim keybindings.', distractor: 'Visual Studio Code installation manual',
    exact: 'Visual Studio Code', synonym: 'modal text editing', colloquial: 'Vim keybindings 好用吗我用啥', cross: '首选代码编辑器', broad: 'editor' },
  { id: 'exercise', content: '我每周三晚上游泳，周日早上跑步五公里。', distractor: '游泳馆广告与跑步比赛规则',
    exact: '周三晚上游泳', synonym: '每星期水中运动', colloquial: '周日早上跑步多远', cross: 'Wednesday evening swimming', broad: '跑步' },
  { id: 'budget', content: 'My monthly grocery budget is three hundred dollars.', distractor: 'monthly grocery budget spreadsheet guide',
    exact: 'grocery budget', synonym: 'food spending allowance', colloquial: 'grocery budget 这月多少', cross: '每月买菜预算', broad: 'budget' },
  { id: 'contact', content: '我希望工作联系走邮件，紧急情况再打电话。', distractor: '邮件服务器设置和电话套餐',
    exact: '工作联系走邮件', synonym: '电子信箱沟通优先', colloquial: '急事再打电话行不', cross: 'prefer email for work', broad: '邮件' },
] as const;
export const categories = ['exact', 'synonym', 'colloquial', 'cross', 'temporal', 'distractor'] as const;
export type RetrievalCategory = typeof categories[number];
export const clock = {
  past: Date.parse('2026-01-01T00:00:00Z'), current: Date.parse('2026-06-01T00:00:00Z'), future: Date.parse('2027-01-01T00:00:00Z'),
};
export const timelines = [
  { id: 'city', contents: ['我的居住城市是上海。', '我的居住城市是杭州。', '我的居住城市是深圳。'], query: '居住城市' },
  { id: 'work', contents: ['I work as a teacher.', 'I work as an engineer.', 'I work as a designer.'], query: 'work' },
] as const;
