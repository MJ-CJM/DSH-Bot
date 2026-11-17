import { expect, it } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SupergroupWork } from '../../src/shared/supergroup.js';
import { recoveryView, continuousCapabilities } from '../../src/host/supergroup/recovery-view.js';
const work = (): SupergroupWork => ({ id: 'w', revision: 1, owner: { botId: 'a', botCreatedAt: 1 }, readers: [{ botId: 'a', botCreatedAt: 1 }],
  originSessionId: 's', inputMessageId: 'i', inputMessageIds: ['i'], configDigest: 'd', createdAt: 1, updatedAt: 1, expiresAt: 10000,
  turnIds: [], experts: [], groupInputs: [], state: 'partial' });
it('projects waiting, readiness, dispatch and unknown from authority without dispatching', () => {
  const w = work(); expect(recoveryView(w, [], false).state).toBe('waiting-input');
  w.blockers = [{ id: 'b', assignmentId: 'a', desiredRevision: 1, reason: 'credential', observedAt: 1, state: 'ready' }];
  expect(recoveryView(w, [], false).state).toBe('ready-to-resume');
  w.state = 'unknown'; expect(recoveryView(w, [], false).state).toBe('unknown');
  w.state = 'cancelled'; expect(recoveryView(w, [], false).state).toBe('closed');
});
it('distinguishes a live approval from an unrecoverable audit tail and never promises deferred tool continuation', () => {
  const events = [{ type: 'user/message', seq: 0, data: { id: 'i', source: { kind: 'user' }, content: [] } }, { type: 'approval/asked', seq: 1, data: { id: 'a', toolName: 'read' } }] as unknown as SessionEvent[];
  expect(recoveryView(work(), events, true)).toMatchObject({ state: 'waiting-approval', holdsAgent: true, durableToolResume: false });
  expect(recoveryView(work(), events, false)).toMatchObject({ state: 'unknown', holdsAgent: false });
  events.push({ type: 'approval/decided', seq: 2, data: { id: 'a', outcome: 'rejected' } } as unknown as SessionEvent);
  expect(recoveryView(work(), events, false).nativeApprovalCount).toBe(0);
  expect(continuousCapabilities).toMatchObject({ timerWakeup: false, durableToolResume: false });
});
