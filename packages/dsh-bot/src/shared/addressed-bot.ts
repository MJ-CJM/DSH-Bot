// Only a direct instruction at the start of the human message can address a guest.
const address = /^(?:[@＠]|(?:(?:请|麻烦)?(?:你)?(?:帮我)?(?:去)?问(?:一问|一下|下|问)?|(?:please\s+)?ask\b)\s*[@＠]?)/iu;

const delegation = /^(?:(?:请让|让|请叫|叫)\s*|(?:please\s+)?(?:have|let)\s+)/iu;
export const isGroupDelegation = (text: string) => delegation.test(text.trimStart());
export const isAddressedQuestion = (text: string) => address.test(text.trimStart());

/** Unknown @handles and visibly delimited Latin Bot names are explicit addresses.
 * Generic questions such as “问一下这个问题” still use the group's normal route. */
export function hasExplicitBotAddress(text: string): boolean {
  const trimmed = text.trim();
  const command = address.exec(trimmed);
  if (!command) return false;
  if (/[@＠]/u.test(command[0])) return true;
  const rest = trimmed.slice(command[0].length);
  if (/^[^\s:：，,]+\s*[:：]/u.test(rest)) return true;
  // A bare polite “请问 SQL 是什么” and “ask a question” often introduce a topic.
  const name = /^[A-Za-z][A-Za-z0-9_-]*(?=[\s:：，,]|[\p{Script=Han}]|$)/u.exec(rest)?.[0];
  return Boolean(name && (/[下你去帮]/u.test(command[0]) || /^[A-Z][a-z]/u.test(name)));
}

type NamedBot = { name: string; id?: string; bot?: { botId: string } };
const normalize = (name: string) => name.normalize('NFKC').toLowerCase();

export function matchAddressedBot<T extends NamedBot>(text: string, bots: readonly T[]):
  { kind: 'match'; bot: T; question: string } | { kind: 'ambiguous' } | undefined {
  const trimmed = text.trim();
  const command = address.exec(trimmed);
  if (!command) return;
  const rest = trimmed.slice(command[0].length).trimStart();
  // Directory entries have an id; an already accepted handoff has an immutable BotKey.
  const at = /[@＠]/u.test(command[0]);
  const aliases = bots.flatMap(bot => [...new Set([bot.name, at ? bot.id ?? bot.bot?.botId : undefined])]
    .flatMap(name => name ? [{ bot, name }] : []));
  const matches = aliases.filter(({ name }) => {
    if (normalize(rest.slice(0, name.length)) !== normalize(name)) return false;
    // "Jarvis2" is not an address to "Jarvis"; Han questions can directly follow a Latin name.
    return !/^[\p{Script=Latin}\p{N}_-]/u.test(rest.slice(name.length));
  }).sort((a, b) => b.name.length - a.name.length);
  const match = matches[0];
  if (!match) return;
  if (matches.some(other => other.name.length === match.name.length && other.bot !== match.bot)) return { kind: 'ambiguous' };
  const question = rest.slice(match.name.length).replace(/^[\s:：，,]+/u, '').trim();
  // Do not forward a multi-recipient request or an empty instruction to one guessed recipient.
  const joined = /^(?:and\s+|[和与及]\s*)/iu.exec(question);
  if (!question || /^[@＠、]/u.test(question)) return { kind: 'ambiguous' };
  if (joined) {
    const next = question.slice(joined[0].length).toLowerCase();
    if (/^[@＠]/u.test(next) || bots.some(other => next.startsWith(other.name.toLowerCase())))
      return { kind: 'ambiguous' };
  }
  return { kind: 'match', bot: match.bot, question };
}

/** An explicit addressee outranks a quoted speaker. Only a delegation verb binds the second addressee. */
export function matchGroupAddress<T extends NamedBot>(text: string, bots: readonly T[], replyAuthor?: T, mentionableBots?: readonly T[]):
  { kind: 'match'; bot: T; question: string; via?: T } | { kind: 'ambiguous' | 'nonmember-mention' } | undefined {
  function resolveInstruction(instruction: string) {
    const command = address.exec(instruction);
    if (!mentionableBots || !command || !/[@＠]/u.test(command[0])) return matchAddressedBot(instruction, bots);
    if (/^everyone(?:$|[\s.,!?，。！？:;：；)）])/u.test(normalize(instruction.slice(command[0].length)))) return;
    return matchAddressedBot(instruction, mentionableBots) ?? { kind: 'nonmember-mention' as const };
  }
  const trimmed = text.trimStart();
  const requester = delegation.exec(trimmed);
  const named = requester && trimmed.slice(requester[0].length);
  const outer = named && !/^[@＠]/u.test(named) ? matchAddressedBot('@' + named, bots) : resolveInstruction(named || trimmed);
  if (!outer || outer.kind !== 'match') return outer;
  if (requester || /^[@＠]/u.test(trimmed)) {
    const instruction = outer.question.replace(/^(?:请|帮我)?(?:你)?(?:去|帮忙)?(?=问)/u, '');
    if (!/^(?:问|(?:please\s+)?ask\s)/iu.test(instruction)) return requester ? undefined : outer;
    const inner = resolveInstruction(instruction);
    if (inner?.kind === 'nonmember-mention') return inner;
    if (!inner && !requester && !hasExplicitBotAddress(instruction)) return outer;
    if (!inner || inner.kind !== 'match' || inner.bot === outer.bot) return { kind: 'ambiguous' };
    return { ...inner, via: outer.bot };
  }
  return replyAuthor && replyAuthor !== outer.bot ? { ...outer, via: replyAuthor } : outer;
}

export function relayNeedsTopic(question: string): boolean {
  const text = question.trim();
  const pointer = /这个(?:话题|事)?|这方面|这件事|它|此事/u;
  if (pointer.test(text)) {
    const rest = text.replace(pointer, '').replace(/有没有什么|有没有哪些|有没有|有没有和|类似|相关|关于|近期|最近|是否|情况|消息|研究|进展|结果|资料|案例|线索|信息|更新|新闻|什么|哪些|请问|查一下|查下|[有无和跟与的吗呢请还\s，。！？?!]/gu, '');
    if (!rest) return true;
  }
  return /^(?:any(?:thing)?|is there anything|have you seen anything|what is|what about)\s+(?:related to |new on |about )?(?:this|that|it)[?!. ]*$/iu.test(text);
}
