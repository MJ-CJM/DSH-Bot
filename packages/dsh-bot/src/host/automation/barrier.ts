import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-user-approval';
import type { RunRecord, RunStatus } from '../../shared/automation.js';
import { hasCredential } from '../../shared/secrets.js';

export interface Observation {
  events: readonly SessionEvent[];
  idle: boolean;
  inboxEmpty: boolean;
  jobs: { id: string; status: string }[];
  children: { id: string; activity: 'running' | 'inactive' | 'unknown' }[];
}
export function inspectBarrier(observation: Observation, run: RunRecord) {
  const { events, jobs, children } = observation;
  const inputIndex = events.findIndex(e => e.type === 'user/message' && e.data.source.kind === 'user'
    && 'rpcId' in e.data.source && e.data.source.rpcId === run.requestId);
  const input = events[inputIndex];
  const start = inputIndex < 0 ? undefined : events.slice(0, inputIndex).findLast(e => e.type === 'turn/start');
  const turn = start?.type === 'turn/start' ? start.data.turn : undefined;
  const relevant = start ? events.slice(events.indexOf(start)) : [];
  const ends = relevant.filter(e => e.type === 'turn/end');
  const end = ends.find(e => e.data.turn === turn);
  const entered = relevant.some(e => e.type === 'step/start' && e.data.turn === turn);
  const pendingApprovals = new Set<string>();
  const openTurns = new Set<number>();
  for (const event of relevant) {
    if (event.type === 'turn/start') openTurns.add(event.data.turn);
    if (event.type === 'turn/end') openTurns.delete(event.data.turn);
    if (event.type === 'approval/asked') pendingApprovals.add(event.data.id);
    if (event.type === 'approval/decided') pendingApprovals.delete(event.data.id);
  }
  const chainStopped = observation.idle && observation.inboxEmpty && openTurns.size === 0 && pendingApprovals.size === 0
    && jobs.every(j => ['completed', 'failed', 'killed'].includes(j.status))
    && children.every(c => c.activity === 'inactive');
  const failed = ends.find(e => e.data.reason.kind !== 'completed');
  const kind = failed?.data.reason.kind;
  const outcome: RunStatus | undefined = kind === 'interrupted' || kind === 'forked' ? 'recovery_needed'
    : kind === 'aborted' ? 'cancelled' : kind ? 'failed' : end && entered ? 'succeeded' : undefined;
  const reply = relevant.findLast(e => e.type === 'assistant/message');
  const rawSummary = reply?.type === 'assistant/message'
    ? reply.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
  const summary = hasCredential(rawSummary) ? '[redacted]' : rawSummary.slice(0, 8192);
  const last = events.at(-1);
  return {
    chainStopped, outcome, waitingApproval: pendingApprovals.size > 0,
    errorCode: kind ? `turn/${kind}` : undefined,
    progress: {
      ...(input?.type === 'user/message' ? { inputMessageId: input.data.id } : {}),
      ...(turn === undefined ? {} : { inputTurn: turn }),
      ...(last ? { lastEventSeq: last.seq } : {}),
      execution: { turns: relevant.filter(e => e.type === 'turn/start').map(e => e.data.turn),
        jobIds: jobs.map(j => j.id), childSessionIds: children.map(c => c.id), activationIds: [] },
      summary,
    },
  };
}
