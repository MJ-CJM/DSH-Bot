import { hasCredential } from '../../shared/secrets.js';

/** Extract the addressed part of a real human input. Never accept the main model's proposed
 * text as evidence that a private chat fragment can be forwarded. */
export function addressedPeerTask(raw: string, targetId: string, directory: readonly { id: string; name: string }[]) {
  const input = raw.trimStart();
  // "What can Jarvis do? Ask him." Limit the projection to the last self-contained
  // question and require an unambiguous directory identity in that question.
  const trailing = /([^\n\r:：,，;；。！？!?]+[?？])\s*(?:你(?:再|帮我)?)?(?:问问|问一下|问下)(?:他|她|对方)[。！!]?\s*$/u.exec(input);
  if (trailing) {
    const question = trailing[1]!.trim();
    const identities = directory.filter(bot => [bot.name, bot.id].some(alias => {
      if (!alias) return false;
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, 'iu').test(question);
    }));
    if (identities.length === 1 && identities[0]!.id === targetId && !hasCredential(question)) return question;
  }
  const prefix = /^(?:@|(?:请|麻烦)?(?:你)?(?:再|直接)?(?:帮我)?(?:问(?:问|一下|下)?|让|请|告诉|通知|转告|追问)\s*@?|(?:please\s+)?(?:ask|tell|notify|message)\s+@?)/iu.exec(input);
  if (!prefix) return;
  const rest = input.slice(prefix[0].length);
  const matches = directory.flatMap(bot => [...new Set([bot.name, bot.id])].filter(alias => {
    if (!alias || !rest.toLowerCase().startsWith(alias.toLowerCase())) return false;
    const after = rest.slice(alias.length);
    return /^(?:\s|[：:,，]|查|调研|研究|分析|解释|比较|总结|核对|给|看看|帮|再|搜|为什么|如何|怎么|能否|是否)/u.test(after);
  }).map(alias => ({ id: bot.id, length: alias.length }))).sort((a, b) => b.length - a.length);
  const match = matches[0];
  // A user may also delegate the choice of teammate to their Bot.
  const anyPeer = /^(?:(?:一位|一个|其他|别的|合适的)(?:合适的)?\s*(?:bot|机器人|助手)|(?:a|another) teammate)\s*/iu.exec(rest);
  if (match && (match.id !== targetId || matches.some(row => row.length === match.length && row.id !== targetId))) return;
  const length = match?.length ?? anyPeer?.[0].length;
  if (!length) return;
  const body = rest.slice(length).replace(/^\s*[:：,，]?\s*/u, '');
  // Explicit quotes delimit the entire intended material. For an unquoted directive,
  // take only the addressed clause, excluding following commentary to the main Bot.
  const quoted = /^(?:「([^」]+)」|“([^”]+)”|"([^"\n]+)")/u.exec(body);
  if (!quoted && /^["“「]/u.test(body)) return;
  const text = (quoted ? quoted[1] ?? quoted[2] ?? quoted[3] : /^[^\n\r，,;；。！？!?]+[。！？!?]?/u.exec(body)?.[0]?.split(/\.\s/u)[0])?.trim();
  return text && !hasCredential(text) ? text : undefined;
}
