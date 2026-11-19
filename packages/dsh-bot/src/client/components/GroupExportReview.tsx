import { hasOperationCode } from '../../shared/operation-errors.js';
import { useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupDelivery, GroupKey, GroupRecord, GroupTurn, GroupViewDelivery } from '../../shared/groups.js';
import { groupExportReviewStatus } from '../../shared/group-export-review.js';
import { type GroupActions, unwrapGroup } from '../groups-state.js';
import styles from '../styles/groups.module.css';

type Preview = { token: string; deliveryRevision: number; flowId: string; groupName: string; recipients: { name: string }[]; content: string };
export const exportStatusKey = (group: GroupRecord, turn: GroupTurn, delivery: GroupViewDelivery) => {
  if (delivery.staleExportClosedAt !== undefined) return 'groups.export.expiredClosed' as const;
  const status = groupExportReviewStatus(group, turn, delivery);
  if (status === 'stale') return 'groups.export.expiredStatus' as const;
  if (status === 'pending' && delivery.reasonCode === 'export-approval-required') return 'groups.export.pending' as const;
  switch (delivery.reasonCode) {
    case 'export-rejected': return 'groups.export.rejected' as const;
    case 'export-blocked': return 'groups.export.blocked' as const;
    case 'export-delivery-unknown': return 'groups.export.unknown' as const;
    default: return undefined;
  }
};
/** Keep a pending approval visible when a turn has results in more than one state. */
export const turnExportStatus = (group: GroupRecord, turn: GroupTurn, deliveries: readonly GroupViewDelivery[]) => {
  const keys = deliveries.map(delivery => exportStatusKey(group, turn, delivery));
  if (keys.includes('groups.export.pending')) return 'groups.export.pending' as const;
  if (keys.includes('groups.export.expiredStatus')) return 'groups.export.expiredStatus' as const;
  if (keys.includes('groups.export.expiredClosed')) return 'groups.export.expiredClosed' as const;
};
export function GroupExportReview({ group, delivery, actions, disabled, t }: {
  group: GroupKey; delivery: GroupDelivery; actions: GroupActions; disabled?: boolean;
} & PropsLocale<'dsh-bot'>) {
  const [preview, setPreview] = useState<Preview>(), [busy, setBusy] = useState(false), [failed, setFailed] = useState<'changed' | 'unavailable' | 'uncertain' | 'preferenceFailed' | 'sentReceiptFailed'>();
  const lock = useRef(false);
  const identity = `${delivery.id}/${delivery.revision}/${delivery.exportFlowId}`;
  const [reviewed, setReviewed] = useState('');
  const current = reviewed === identity ? preview : undefined;
  const perform = async (work: () => Promise<void>) => {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setFailed(undefined);
    try { await work(); } catch (error) { setPreview(undefined); setFailed(hasOperationCode(error, 'group-export-preference-failed') ? 'preferenceFailed' : hasOperationCode(error, 'group-export-sent-receipt-failed') ? 'sentReceiptFailed' : hasOperationCode(error, 'conflict') ? 'changed' : hasOperationCode(error, 'group-data-blocked') ? 'unavailable' : 'uncertain'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className={styles.exportReview} data-group-export-review={delivery.id}>
    {!current && <button type="button" disabled={disabled || busy} onClick={() => { void perform(async () => {
      const result = unwrapGroup(await actions.remote().reviewExport(group, delivery.id));
      await actions.messageView(group).refresh();
      setPreview(result); setReviewed(`${delivery.id}/${result.deliveryRevision}/${result.flowId}`);
    }); }}>{t('groups.export.review')}</button>}
    {current && <>
      <p>{t('groups.export.scope', { group: current.groupName, members: current.recipients.map(row => row.name).join('、') })}</p>
      <p>{t('groups.export.notice')}</p><p>{t('groups.export.policySettingsHint')}</p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The complete scrollable export must be keyboard-readable before approval. */}
      <pre className={styles.exportBody} tabIndex={0}>{current.content}</pre>
      {([true, false] as const).map(allow => <button type="button" key={String(allow)} disabled={disabled || busy} onClick={() => {
        void perform(async () => {
          // Clear before dispatch: an uncertain response must be reconciled, never resubmitted.
          setPreview(undefined);
          unwrapGroup(await actions.remote().decideExport(group, delivery.id, current.token, allow));
          await Promise.all([actions.messageView(group).refresh(), actions.catalog.refresh()]);
        });
      }}>{t(allow ? 'groups.export.allow' : 'groups.export.reject')}</button>)}
      <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>{t('groups.export.close')}</button>
    </>}
    {failed && <p role="alert">{t(failed === 'preferenceFailed' || failed === 'sentReceiptFailed' ? `groups.export.receipt.${failed}` : `groups.export.${failed}`)}</p>}
  </section>;
}
