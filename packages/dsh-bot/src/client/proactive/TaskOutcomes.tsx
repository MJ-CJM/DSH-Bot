import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ProactiveWork } from '../../shared/proactive/work.js';
import { taskOutcomes } from '../../shared/proactive/outcomes.js';
export function TaskOutcomes({ rows, complete, t }: PropsLocale<'dsh-bot'> & { rows: readonly ProactiveWork[]; complete: boolean }) {
  const report = taskOutcomes(rows, complete);
  return <details data-task-outcomes><summary>{t('proactive.outcomes')}</summary>
    <p>{t(report.complete ? 'proactive.outcomesComplete' : 'proactive.outcomesPartial', { count: report.enrolled })}</p>
    <p>{t('proactive.outcomesCaveat')}</p>
    {report.cohorts.map(row => <div key={JSON.stringify([row.mode, row.collaboration, row.model, row.kind])}>
      <p>{t(`proactive.outcomeMode.${row.mode}`)} · {t(`proactive.outcomeTeam.${row.collaboration}`)} · {row.model} · {t(`proactive.outcomeKind.${row.kind === "ci-analysis" || row.kind === "document-analysis" ? row.kind : "unmeasured"}`)}</p>
      <p>{t('proactive.outcomeCounts', row)}</p>
    </div>)}
    <p>{t('proactive.outcomesUnmeasured')}</p>
  </details>;
}
