import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { activityRecordSchema } from '../../shared/activity.js';
import { createActivityPreview } from '../../shared/activity-preview.js';

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    dshBotFirstUserPreview: string | null;
  }
}

/** A bounded Host-only projection: public registry materialization restores its
 * state, and complete future events advance it without direct history reads.
 * null means no human message; an empty string remembers image-only input.
 */
export const firstUserProjection = {
  key: 'dshBotFirstUserPreview', stateVersion: 1,
  stateSchema: activityRecordSchema.shape.firstUserPreview.unwrap().nullable(),
  init: () => null,
  apply: (state, event) => {
    if (state !== null || event.type !== 'user/message'
      || event.data.source.kind !== 'user' || event.surfaceOp !== 'append') return state;
    return createActivityPreview(event.data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'));
  },
} satisfies ProjectionDefinition<'dshBotFirstUserPreview', string | null>;
