import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useRef } from 'react';
export interface ChatLauncherActions {
  onStart(id: string, signal?: AbortSignal): Promise<void>;
  onStartInWorkspace(id: string, workspaceId: string, signal?: AbortSignal): Promise<void>;
  getPreferredWorkspace(): string;
}
type WorkspaceSnapshot = ReturnType<Context['workspaces']['list']['getSnapshot']>;
/** Every surface opens the Host-owned main; no alternate-workspace creation path. */
export function useChatLauncher({ onStart }: ChatLauncherActions & {
  workspaces: WorkspaceSnapshot; t: PropsLocale<'dsh-bot'>['t'];
}) {
  const lifetime = useRef<AbortController>();
  useEffect(() => { lifetime.current = new AbortController(); return () => lifetime.current?.abort(); }, []);
  const start = (id: string) => lifetime.current?.signal.aborted ? Promise.resolve() : onStart(id, lifetime.current?.signal);
  return { start, startInWorkspace: start, dialog: null };
}
