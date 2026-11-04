import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client';
import { DisclosureRow, IconThinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots';
import type { ExecutionBridge } from '../group-execution.js';
import { hasPermissionDenial } from '../group-permission-denial.js';
import styles from '../styles/groups.module.css';

type Source = { subscribe(listener: () => void): () => void; getSnapshot(): ChatSnapshot | undefined };
const empty: Source = { subscribe: () => () => {}, getSnapshot: () => undefined };

/** Read the native Chat projection, including live chunks and interruption-frozen prefixes. */
export function memberReasoning(snapshot: ChatSnapshot | undefined) {
  return (snapshot?.nodes.values() ?? []).filter(node => node.kind === 'assistant-step' && node.visibility === 'visible')
    .sort((a, b) => a.anchorSeq - b.anchorSeq).flatMap(node => {
      const assistant = node as ChatNode<'assistant-step'>;
      return assistant.data.blocks.flatMap((block, index) => block.kind === 'reasoning' && block.text
        ? [{ key: `${node.key}:${index}`, text: block.text, running: assistant.data.status === 'running' }]
        : []);
    });
}

/**
 * Observe one member's native Chat projection. Read-only: retaining a Session
 * never starts or resumes an Agent. Shares the statistics reference when present.
 */
export function useMemberChat(bridge: ExecutionBridge, parentId: string, childId: string, readyToRead: boolean) {
  const [source, setSource] = useState<{ childId: string; value: Source }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setSource(undefined); setFailed(false);
    // The delivery reserves a child ID before native startActivation has created it.
    if (!readyToRead) return;
    let alive = true;
    const release = bridge.ctx.effect(() => {
      try {
        if (bridge.statistics) {
          const statistics = bridge.statistics.source(parentId, childId);
          const update = () => {
            if (!alive) return;
            const current = statistics.getSnapshot();
            if (current.state === 'unavailable') { setFailed(true); return; }
            if (!current.binding) return;
            const conversation = bridge.ctx.get('uiConversation');
            if (!conversation) { setFailed(true); return; }
            setSource({ childId, value: conversation.binding(current.binding).target('chat') });
          };
          const off = statistics.subscribe(update); update();
          return () => { alive = false; off(); };
        }
        const sessions = bridge.ctx.get('sessions') as unknown as ISessions;
        // Fresh workers need not be in the global Session catalog yet. The public
        // parent/child address opens their native history directly, without waking them.
        const reference = sessions.retain({ parentSessionId: parentId as SessionId, childSessionId: childId as SessionId, mode: 'unknown' }, { source: 'dshBotGroupExecution' });
        void reference.ready.then(() => {
          if (!alive) return;
          if (reference.binding.session.getSnapshot().openState === 'error') throw new Error('Child history unavailable');
          const conversation = bridge.ctx.get('uiConversation');
          if (!conversation) throw new Error('Conversation service unavailable');
          const value = conversation.binding(reference.binding).target('chat');
          setSource({ childId, value });
        }).catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; reference.release(); };
      } catch { if (alive) setFailed(true); return () => { alive = false; }; }
    }, 'dsh-bot: member reasoning projection');
    return () => { alive = false; release(); };
  }, [bridge, parentId, childId, readyToRead]);
  const current = readyToRead && source?.childId === childId ? source.value : empty;
  const snapshot = useSyncExternalStore(current.subscribe, current.getSnapshot);
  return { snapshot, failed };
}

/** Report whether a member's loaded native tool results include an access-mode denial; renders nothing. */
export function GroupPermissionDenialProbe({ parentId, childId, bridge, onChange }: {
  parentId: string; childId: string; bridge: ExecutionBridge; onChange(childId: string, denied: boolean): void;
}) {
  const { snapshot } = useMemberChat(bridge, parentId, childId, true);
  const denied = hasPermissionDenial(snapshot);
  useEffect(() => { onChange(childId, denied); }, [childId, denied, onChange]);
  useEffect(() => () => onChange(childId, false), [childId, onChange]);
  return null;
}

/** Observe only: retaining a Session and expanding its text never starts or resumes an Agent. */
export function GroupMemberProcess({ parentId, childId, readyToRead, bridge, renderFactorySlot, t }: {
  parentId: string; childId: string; readyToRead: boolean; bridge: ExecutionBridge;
} & PropsRenderFactories & PropsLocale<'dsh-bot'>) {
  const { snapshot, failed } = useMemberChat(bridge, parentId, childId, readyToRead);
  // Disclosure state belongs to one exact readable child; a new identity starts folded.
  const identity = JSON.stringify([parentId, childId, readyToRead]);
  const [openFor, setOpenFor] = useState<string>();
  const open = openFor === identity, setOpen = (next: (value: boolean) => boolean) => setOpenFor(next(open) ? identity : undefined);
  const reasoning = memberReasoning(snapshot);
  const latest = reasoning.at(-1);
  return <div className={styles.nativeProcess} data-group-member-process={childId}>
    {failed ? <p role="status">{t('execution.unavailable')}</p> : !snapshot ? <p role="status">{t('groups.loading')}</p> : latest ?
      <DisclosureRow icon={<IconThinkOutlineRegular size={14} />} title={t('execution.thinking')}
        open={open} expandable expandOnRowClick running={latest.running} onToggle={() => setOpen(value => !value)}
        collapsedContent={<span className={styles.reasoningPreview}>{latest.text.replace(/\s+/g, ' ').slice(-180)}</span>}>
        {open && <div className={styles.reasoningBody}>{reasoning.map(part => <div key={part.key}>
          {renderFactorySlot('conversation.chat.reasoning.content', { text: part.text, running: part.running })}
        </div>)}</div>}
      </DisclosureRow> : <p className={styles.executionMeta}>{t('execution.noReasoning')}</p>}
  </div>;
}
