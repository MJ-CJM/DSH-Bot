import { Context } from '@deepseek-ai/cordis';
import { InputTriggerController, InputTriggerService, type InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { ignoredMentionPosition, type MentionTarget } from './group-mentions.js';
/** A dedicated event scope and roster: never writes to the native editor's controller. */
export function createGroupTrigger(sessionId: string, targets: () => MentionTarget[], insert: (span: { start: number; end: number; draftRev: number }, memberId: string, text: string) => boolean) {
  const scope = new Context();
  let pendingMember = '';
  const source: InputTriggerSource = { trigger: '@', name: 'dsh-bot-group-members',
    async candidates(_session, request) {
      const query = request.query.normalize('NFKC').toLocaleLowerCase();
      return [{ id: 'everyone', name: 'everyone', botId: 'everyone' }, ...targets()].filter(target => `${target.name} ${target.botId}`.normalize('NFKC').toLocaleLowerCase().includes(query)).map(target => ({ name: target.id, label: target.name, description: target.botId, value: target.id }));
    },
    onPick(pick) { pendingMember = pick.candidate.value ?? ''; return { text: `@${pick.candidate.label ?? pick.candidate.name} ` }; },
  };
  const roster = [source];
  const service = new InputTriggerService(scope);
  scope.effect(() => service.registerSource(source), 'group member source');
  scope.effect(() => scope.on('slash/input-insert-text', request => insert(request.span, pendingMember, request.text) ? true : undefined), 'group mention insertion');
  const controller = new InputTriggerController({ actx: scope, sessionId: sessionId as SessionId, roster: { all: () => roster, sources: trigger => trigger === '@' ? roster : [] } });
  scope.effect(() => () => { roster.length = 0; controller.dispose(); }, 'group mention controller');
  return { controller,
    track(text: string, caret: number, revision: number) { controller.track(text, caret, { tier: ignoredMentionPosition(text, caret) ? 'frozen' : 'plain' }, revision); },
    dispose() { roster.length = 0; controller.dispose(); void scope.fiber.dispose(); },
  };
}
