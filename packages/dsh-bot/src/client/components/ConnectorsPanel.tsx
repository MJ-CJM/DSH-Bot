import { useState } from 'react';
import { type Connector, sameBot } from '../../shared/integrations.js';
import { IntegrationFrame, useIntegrationPanel, type IntegrationPanelProps } from './IntegrationFrame.js';
import { ConnectorEditor } from './ConnectorEditor.js';
export function ConnectorsPanel(props: IntegrationPanelProps & { active?: boolean }) {
  const { actions, t } = props;
  const state = useIntegrationPanel(actions, props.bots);
  const { data, bot, owner, busy, perform } = state;
  const [selection, setSelection] = useState<{ definition?: Connector; version: number }>({ version: 0 });
  return (
    <IntegrationFrame {...props} state={state} title="connectors">
      <p>{t('connectors.templateHint')}</p>
      <p>{t('connectors.credentialsHint')}</p>
      <ul>
        {data.definitions.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => setSelection((old) => ({ definition: d, version: old.version + 1 }))}>
              {d.label} · {d.serverName} · v{d.revision}
            </button>
            {owner && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void perform(async () => {
                    const a = data.assignments.find((a) => sameBot(a.bot, owner) && a.connectorId === d.id);
                    await actions.write(() =>
                      actions.connectors().saveAssignment(
                        {
                          id: a?.id ?? `assignment:${crypto.randomUUID()}`,
                          bot: owner,
                          connectorId: d.id,
                          enabled: !a?.enabled,
                          overrides: a?.overrides ?? {},
                        },
                        a?.revision ?? 0,
                      ),
                    );
                  });
                }}
              >
                {t(
                  data.assignments.some((a) => owner && sameBot(a.bot, owner) && a.connectorId === d.id && a.enabled)
                    ? 'connectors.disconnect'
                    : 'connectors.assign',
                )}
              </button>
            )}
          </li>
        ))}
      </ul>
      <ConnectorEditor
        key={`${owner?.botId}:${owner?.botCreatedAt}:${selection.version}`}
        actions={actions}
        busy={busy}
        perform={perform}
        active={props.active ?? true}
        definition={selection.definition}
        t={t}
      />
      {owner && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void perform(() => actions.write(() => actions.connectors().applyIdle(owner)));
            }}
          >
            {t('connectors.apply')}
          </button>
          {bot?.mcpServers.length ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void perform(() => actions.write(() => actions.connectors().importLegacy(owner)));
              }}
            >
              {t('connectors.importLegacy')}
            </button>
          ) : null}
          <p>{t('connectors.firstOpen')}</p>
          <ul>
            {data.runtime
              .filter((r) => data.assignments.some((a) => a.id === r.assignmentId && sameBot(a.bot, owner)))
              .map((r) => (
                <li key={`${r.sessionId}:${r.assignmentId}`}>
                  {r.sessionId} · {t(`connectors.${r.state}`)} · {r.appliedRevision ?? '—'}/{r.desiredRevision} ·{' '}
                  {r.toolCount} {r.reasonCode ?? ''}
                </li>
              ))}
          </ul>
        </>
      )}
    </IntegrationFrame>
  );
}
