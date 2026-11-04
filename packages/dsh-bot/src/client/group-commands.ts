import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';

/**
 * Entries of the group composer's '/' menu, in display order. `file` and `model` are group
 * features; `permission`, `export` and `feedback` are native Host commands of the group root.
 * The root runs no model, so the Host offers it no goal, plan, compact or model command.
 */
export const GROUP_COMMANDS = ['file', 'model', 'permission', 'export', 'feedback'] as const;
export type GroupCommandName = (typeof GROUP_COMMANDS)[number];
/** Native commands that must appear in the root's Host catalog before the group composer offers them. */
const HOST_GATED: ReadonlySet<GroupCommandName> = new Set(['permission', 'export', 'feedback']);

/** Browser faces of the native session-log-export and message-feedback plugins (public `ctx` services). */
interface SessionLogDownloadFace { download(sessionId: SessionId): Promise<void> }
interface FeedbackFace { openSession(sessionId: SessionId): void }

export interface GroupCommandServices {
  /** Native Host command names for this exact group root; an unreadable catalog yields an empty set. */
  hostCommands(rootSessionId: string): Promise<ReadonlySet<string>>;
  /** Start the native Session-log ZIP download (root plus member sub-sessions); false when not installed. */
  exportLog(rootSessionId: string): boolean;
  /** Open the native Session feedback form; false when not installed. */
  feedback(rootSessionId: string): boolean;
  /** Whether the browser half of a native command is installed. */
  installed(name: 'export' | 'feedback'): boolean;
}

/** Commands to offer, given the group's own features and the root's native catalog. */
export function availableGroupCommands(host: ReadonlySet<string>, local: { file: boolean; model: boolean; permission: boolean },
  installed: (name: 'export' | 'feedback') => boolean): GroupCommandName[] {
  return GROUP_COMMANDS.filter((name) => {
    if (HOST_GATED.has(name) && !host.has(name)) return false;
    if (name === 'export' || name === 'feedback') return installed(name);
    return local[name];
  });
}

/**
 * Exact bare command typed as the whole draft (`/export`, or a localized label such as `/下载日志`).
 * Mirrors the native composer: a bare command submits as the command, not as a message.
 */
export function bareGroupCommand(draft: string, offered: readonly GroupCommandName[], label: (name: GroupCommandName) => string): GroupCommandName | undefined {
  const token = draft.trim();
  if (!token.startsWith('/') || /\s/.test(token)) return undefined;
  const typed = token.slice(1).normalize('NFKC').toLocaleLowerCase();
  return offered.find((name) => name === typed || label(name).normalize('NFKC').toLocaleLowerCase() === typed);
}

export function createGroupCommandServices(ctx: Context): GroupCommandServices {
  const catalogs = new Map<string, Promise<ReadonlySet<string>>>();
  const connection = ctx.get('connection') as ConnectionHandle | undefined;
  ctx.effect(() => {
    const stops = [ctx.remote.$on('commands/change', () => catalogs.clear())];
    // A reconnect may miss change events and can change the Host's command composition.
    if (connection) stops.push(connection.generation.subscribe(() => catalogs.clear()));
    return () => { for (const stop of stops) stop(); catalogs.clear(); };
  }, 'dsh-bot: group command catalog');
  const service = <T>(name: string) => ctx.get(name) as T | undefined;
  return {
    hostCommands(rootSessionId) {
      const cached = catalogs.get(rootSessionId);
      if (cached) return cached;
      const pending = (async () => {
        const remote = ctx.get('remote.commands') as TypertRemoteNamespaceMap['commands'] | undefined;
        if (!remote) return new Set<string>();
        const result = await remote.list(rootSessionId as SessionId);
        if (!result.ok) throw result.error;
        return new Set(result.value.map((row) => row.name));
      })();
      catalogs.set(rootSessionId, pending);
      // Never cache a failure: the next menu open asks the Host again.
      return pending.catch(() => {
        if (catalogs.get(rootSessionId) === pending) catalogs.delete(rootSessionId);
        return new Set<string>();
      });
    },
    exportLog(rootSessionId) {
      const download = service<SessionLogDownloadFace>('sessionLogDownload');
      if (!download) return false;
      void download.download(rootSessionId as SessionId).catch(() => {});
      return true;
    },
    feedback(rootSessionId) {
      const feedback = service<FeedbackFace>('feedbackUi');
      if (!feedback) return false;
      feedback.openSession(rootSessionId as SessionId);
      return true;
    },
    installed: (name) => Boolean(service(name === 'export' ? 'sessionLogDownload' : 'feedbackUi')),
  };
}
