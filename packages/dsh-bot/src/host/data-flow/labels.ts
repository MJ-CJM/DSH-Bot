import { dataLabelSchema, type DataLabel } from '../../shared/data-flow.js';
import { sameBot, type BotKey } from '../../shared/identity.js';

const unique = <T,>(values: T[]) => [...new Set(values)];
export const unknownLabel = (): DataLabel => ({ readers: [], originTrust: 'candidate', sourceVersions: [],
  restrictions: ['no-egress'], grants: [] });
/** Meet of permissions, union of provenance/restrictions. Grants never broaden on merge. */
export function mergeLabels(...inputs: DataLabel[]): DataLabel {
  if (!inputs.length) return unknownLabel();
  const labels = inputs.map(v => dataLabelSchema.parse(v));
  const first = labels[0]; if (!first) return unknownLabel();
  let readers = first.readers;
  for (const next of labels.slice(1)) {
    if (readers === 'shared') readers = next.readers;
    else if (next.readers !== 'shared') {
      const permitted = next.readers;
      readers = readers.filter(key => permitted.some(other => sameBot(key, other)));
    }
  }
  const ranks = ['candidate', 'user_stated', 'user_confirmed'] as const;
  return { readers, originTrust: ranks[Math.min(...labels.map(l => ranks.indexOf(l.originTrust)))] ?? 'candidate',
    sourceVersions: unique(labels.flatMap(l => l.sourceVersions)), restrictions: unique(labels.flatMap(l => l.restrictions)),
    grants: first.grants.filter(id => labels.every(l => l.grants.includes(id))) };
}
export const canReadLabel = (label: DataLabel, bot: BotKey) => label.readers === 'shared' || label.readers.some(key => sameBot(key, bot));
