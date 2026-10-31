import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import type { BotRecord } from '../../shared/schema.js';
export interface BotChanged {
  id: string;
  action: 'create' | 'update' | 'duplicate' | 'remove';
}
export type Lease = { definition: PresetDefinition; bot: BotRecord; dispose: () => Promise<void> };
