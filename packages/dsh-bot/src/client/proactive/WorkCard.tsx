import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useState } from 'react';
import type { ProactiveActions } from './SuggestionPanel.js';
import type { ProactiveWork } from '../../shared/proactive/work.js';
import { ReviewPanel, type ReviewPanelProps } from './ReviewPanel.js';

/** Opening an existing Ticket only reads its evidence. It never dispatches work. */
export function WorkCard({ load, selected, ...props }: ReviewPanelProps & {
  load: ProactiveActions['workDetail']; selected: boolean;
}) {
  const { row, t } = props;
  const [open, setOpen] = useState(selected);
  const [detail, setDetail] = useState<ProactiveWork>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (selected) setOpen(true); }, [selected]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is an explicit user refresh even when the task revision is unchanged.
  useEffect(() => {
    if (!load || !open) return;
    let active = true;
    setDetail(undefined); setFailed(false);
    void load({ owner: { botId: row.target.bot.botId, botCreatedAt: row.target.bot.botCreatedAt }, ticketId: row.ticketId, expectedRevision: row.revision }).then(
      value => { if (active) setDetail(value); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [load, open, row.ticketId, row.revision, row.target.bot.botId, row.target.bot.botCreatedAt, retry]);
  if (!load) return <ReviewPanel {...props} />;
  return <section data-proactive-ticket={row.ticketId} data-work-revision={row.revision} tabIndex={-1}>
    {detail && detail.revision === row.revision ? <><ReviewPanel {...props} row={detail} embedded /><Button variant="ghost" onClick={() => setRetry(retry + 1)}>{t('proactive.refreshDetails')}</Button></> : <>
    <h3>{row.title}</h3><p>{t(`proactive.state.${row.state}`)}</p>
    <Button variant="ghost" disabled={open && !failed} onClick={() => { setOpen(true); setRetry(retry + 1); }}>
      {t(failed ? 'proactive.refresh' : 'proactive.openDetails')}
    </Button>
    {failed && <p role="status">{t('proactive.targetMissing')}</p>}
    </>}
  </section>;
}
