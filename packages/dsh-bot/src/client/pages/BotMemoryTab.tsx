import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useState } from 'react';
import type { BotRecord } from '../../shared/schema.js';
import { MemoryPanel } from '../components/MemoryPanel.js';

import type { BotsPageInjected } from './bots-page-types.js';
/** Allocate owner-bound stores after mount; release them when switching tabs or Bots. */
export function MemoryTab({
  bot,
  create,
  t,
}: {
  bot: BotRecord;
  create: BotsPageInjected['createMemoryPanel'];
  t: PropsLocale<'dsh-bot'>['t'];
}) {
  const [panel, setPanel] = useState<ReturnType<BotsPageInjected['createMemoryPanel']>>();
  useEffect(() => {
    const value = create(bot.id);
    setPanel(value);
    return value.dispose;
  }, [bot.id, create]);
  return panel ? <MemoryPanel {...panel} bot={bot} t={t} /> : <p role="status">{t('memory.loading')}</p>;
}
