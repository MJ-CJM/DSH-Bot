import { useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupKey } from '../shared/groups.js';
import type { BotKey } from '../shared/identity.js';
import type { BotRecord } from '../shared/schema.js';
import type { SupergroupWorkView } from '../shared/supergroup.js';
import type { IntegrationActions } from './integrations-state.js';
import { TaskSupportPanel, type TaskSupportActions } from './task-support.js';

export type WorkScope = { bot: BotKey } | { group: GroupKey };
export interface WorkMaterialsActions {
  list(scope: WorkScope): Promise<SupergroupWorkView[]>;
  tasks: TaskSupportActions;
  integrations?: IntegrationActions;
  openSession?(id: string): Promise<void>;
}

type Props = PropsLocale<'dsh-bot'> & {
  scope: WorkScope;
  sessionId: string;
  actions: WorkMaterialsActions;
  bots: readonly BotRecord[];
};

export function WorkMaterials({ scope, sessionId, actions, bots, t }: Props) {
  const [view, setView] = useState<{ rows?: SupergroupWorkView[]; failed?: boolean }>({});
  const [selected, setSelected] = useState<string>();
  const refresh = useRef<() => void>(undefined);
  const groupId = 'group' in scope ? scope.group.groupId : undefined;
  const groupCreatedAt = 'group' in scope ? scope.group.groupCreatedAt : undefined;
  const botId = 'bot' in scope ? scope.bot.botId : undefined;
  const botCreatedAt = 'bot' in scope ? scope.bot.botCreatedAt : undefined;
  useEffect(() => {
    let alive = true, generation = 0;
    const read = () => {
      const request = ++generation;
      const target: WorkScope | undefined = groupId !== undefined && groupCreatedAt !== undefined ? { group: { groupId, groupCreatedAt } }
        : botId !== undefined && botCreatedAt !== undefined ? { bot: { botId, botCreatedAt } } : undefined;
      if (!target) return;
      void actions.list(target).then(rows => {
        if (!alive || request !== generation) return;
        setView({ rows: rows.filter(({ work, group }) => 'group' in target
          ? work.group?.groupId === target.group.groupId && work.group.groupCreatedAt === target.group.groupCreatedAt &&
            group?.group.id === target.group.groupId && group.group.createdAt === target.group.groupCreatedAt && group.group.rootSessionId === sessionId
          : work.owner.botId === botId && work.owner.botCreatedAt === botCreatedAt && work.originSessionId === sessionId) });
      }, () => { if (alive && request === generation) setView({ failed: true }); });
    };
    const release = actions.tasks.subscribe?.(read);
    refresh.current = read;
    read();
    return () => { alive = false; refresh.current = undefined; release?.(); };
  }, [actions, sessionId, groupId, groupCreatedAt, botId, botCreatedAt]);
  const rows = view.rows ?? [];
  const item = rows.find(row => row.work.id === selected) ?? rows[0];
  if (view.failed) return <p role="alert">{t('supergroup.unavailable')} <button type="button" onClick={() => { setView({}); refresh.current?.(); }}>{t('bots.refresh')}</button></p>;
  if (!view.rows) return <p role="status">{t('groups.loading')}</p>;
  if (!item) return <p>{t('botPanel.taskEmpty')}</p>;
  const { work } = item;
  const owner = bots.find(bot => bot.id === work.owner.botId && bot.createdAt === work.owner.botCreatedAt);
  return <section data-work-materials="">
    {rows.length > 1 && <label>{t('botPanel.tasks')} <select value={work.id} onChange={event => setSelected(event.currentTarget.value)}>
      {rows.map(row => <option key={row.work.id} value={row.work.id}>{new Date(row.work.createdAt).toLocaleString(t('activity.locale'))} · {t(`supergroup.${row.work.state}`)}</option>)}
    </select></label>}
    <TaskSupportPanel workId={work.id} actions={actions.tasks} integrations={actions.integrations} bot={owner}
      readOnly={!owner || work.state === 'cancelled' || work.state === 'unknown'} openSession={actions.openSession} t={t} />
  </section>;
}
