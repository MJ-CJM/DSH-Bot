import type { GroupSummary } from '../../shared/groups.js';
import type { SupergroupWorkView } from '../../shared/supergroup.js';

/** Re-read exact authority before cancelling. A stale navigation projection
 * must not turn a delivered or uncertain work into a cancelled work. */
export async function stopGroupWork(group: GroupSummary['group'], actions: {
  read(): Promise<SupergroupWorkView | null>;
  cancel(work: SupergroupWorkView['work']): Promise<void>;
  refresh(): Promise<void>;
}) {
  const metadata = group.supergroup;
  if (!metadata) throw new Error('Automatic group unavailable');
  const view = await actions.read(), work = view?.work;
  if (!work || work.id !== metadata.workId || work.originSessionId !== metadata.originSessionId
    || work.owner.botId !== metadata.owner.botId || work.owner.botCreatedAt !== metadata.owner.botCreatedAt
    || work.group?.groupId !== group.id || work.group.groupCreatedAt !== group.createdAt
    || view.group?.group.id !== group.id || view.group.group.createdAt !== group.createdAt
    || view.group.group.rootSessionId !== group.rootSessionId) throw new Error('Supergroup stop identity mismatch');
  if (work.state === 'creating' || work.state === 'running') await actions.cancel(work);
  await actions.refresh();
}
