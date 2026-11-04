import { Context } from '@deepseek-ai/cordis';
import { InputTriggerController, InputTriggerService, type InputTriggerCandidate, type InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { ignoredMentionPosition, type MentionTarget } from './group-mentions.js';
export const GROUP_COMMAND_SOURCE = 'dsh-bot-group-commands';
/** The group composer's '/' entries: rows to offer now, and what a pick runs. */
export interface GroupCommandSource {
  rows(signal: AbortSignal): Promise<readonly InputTriggerCandidate[]>;
  run(name: string): void;
}
type Span = { start: number; end: number; draftRev: number };
const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase();
/**
 * A dedicated event scope and roster: never writes to the native editor's controller.
 * '@' picks a member; a leading '/' lists group commands like the native composer menu.
 * A command pick first removes its typed token, then runs.
 */
export function createGroupTrigger(sessionId: string, targets: () => MentionTarget[], insert: (span: Span, memberId: string | undefined, text: string) => boolean,
  commands?: () => GroupCommandSource | undefined) {
  const scope = new Context();
  let pending: { kind: 'member'; memberId: string } | { kind: 'command'; name: string } | undefined;
  const members: InputTriggerSource = { trigger: '@', name: 'dsh-bot-group-members',
    async candidates(_session, request) {
      const query = fold(request.query);
      return [{ id: 'everyone', name: 'everyone', botId: 'everyone' }, ...targets()].filter(target => fold(`${target.name} ${target.botId}`).includes(query)).map(target => ({ name: target.id, label: target.name, description: target.botId, value: target.id }));
    },
    onPick(pick) { pending = { kind: 'member', memberId: pick.candidate.value ?? '' }; return { text: `@${pick.candidate.label ?? pick.candidate.name} ` }; },
  };
  const slash: InputTriggerSource = { trigger: '/', name: GROUP_COMMAND_SOURCE, showGroupTitle: false,
    async candidates(_session, request) {
      const source = commands?.();
      // Commands own the whole draft, as in the native menu; an inline '/' stays plain text.
      if (!source || request.position !== 'leading') return [];
      const query = fold(request.query);
      return (await source.rows(request.signal)).filter(row => fold(`${row.name} ${row.label ?? ''}`).includes(query));
    },
    onPick(pick) { pending = { kind: 'command', name: pick.candidate.name }; return { text: '' }; },
  };
  const roster = [members, slash];
  const service = new InputTriggerService(scope);
  for (const source of roster) scope.effect(() => service.registerSource(source), `group ${source.trigger} source`);
  scope.effect(() => scope.on('slash/input-insert-text', request => {
    const pick = pending; pending = undefined;
    if (pick?.kind === 'command') {
      if (!insert(request.span, undefined, '')) return undefined;
      commands?.()?.run(pick.name);
      return true;
    }
    return insert(request.span, pick?.memberId ?? '', request.text) ? true : undefined;
  }), 'group trigger insertion');
  const controller = new InputTriggerController({ actx: scope, sessionId: sessionId as SessionId,
    roster: { all: () => roster, sources: trigger => roster.filter(source => source.trigger === trigger) } });
  scope.effect(() => () => { roster.length = 0; controller.dispose(); }, 'group trigger controller');
  return { controller,
    track(text: string, caret: number, revision: number) { controller.track(text, caret, { tier: ignoredMentionPosition(text, caret) ? 'frozen' : 'plain' }, revision); },
    /** Toggle the command menu at the caret, like the native composer's add button. */
    toggleCommands(caret: number, revision: number) {
      controller.toggleSource(GROUP_COMMAND_SOURCE, { trigger: '/', query: '', quoted: false, position: 'leading', span: { start: caret, end: caret, draftRev: revision } });
    },
    dispose() { roster.length = 0; controller.dispose(); void scope.fiber.dispose(); },
  };
}
