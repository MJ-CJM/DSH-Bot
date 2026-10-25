import { useCallback, useEffect, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { CONNECTOR_TEMPLATES, type Connector } from '../../shared/integrations.js';
import type { IntegrationActions } from '../integrations-state.js';
import { CredentialEditor } from './CredentialEditor.js';
export function ConnectorEditor({
  actions,
  definition,
  active,
  busy,
  perform,
  t,
}: PropsLocale<'dsh-bot'> & {
  actions: IntegrationActions;
  definition?: Connector;
  active: boolean;
  busy: boolean;
  perform(fn: () => Promise<unknown>): Promise<void>;
}) {
  const [draft, setDraft] = useState<Connector>();
  const [credentialEpoch, setCredentialEpoch] = useState(0);
  const [definitionId, setDefinitionId] = useState('');
  const [label, setLabel] = useState('');
  const [template, setTemplate] = useState('github');
  const [serverName, setServerName] = useState('github');
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('streamable-http');
  const [endpoint, setEndpoint] = useState('');
  const [args, setArgs] = useState('');
  const [credential, setCredential] = useState('');
  const [envKey, setEnvKey] = useState('TOKEN');
  const [enabled, setEnabled] = useState(false);
  const edit = useCallback((d?: Connector) => {
    setCredentialEpoch((epoch) => epoch + 1);
    setDraft(d);
    setDefinitionId(d?.id ?? '');
    setLabel(d?.label ?? '');
    setTemplate(d?.templateId ?? 'github');
    setServerName(d?.serverName ?? 'github');
    setTransport(d?.transport ?? 'streamable-http');
    setEndpoint(d?.url ?? d?.command ?? '');
    setArgs(d?.args.join('\n') ?? '');
    setCredential(d?.credentialBindings[0]?.credentialRef ?? '');
    setEnvKey(d?.credentialBindings[0]?.key ?? 'TOKEN');
    setEnabled(d?.enabled ?? false);
  }, []);
  useEffect(() => {
    edit(definition);
  }, [definition, edit]);
  return (
    <>
      <button type="button" onClick={() => edit()}>
        {t('connectors.newConnector')}
      </button>{' '}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            const d = await actions.write(() =>
              actions.connectors().saveDefinition(
                {
                  id: definitionId,
                  label,
                  templateId: template as Connector['templateId'],
                  templateVersion: 1,
                  serverName,
                  transport,
                  ...(transport === 'stdio'
                    ? { command: endpoint, args: args.split('\n').filter(Boolean) }
                    : { url: endpoint }),
                  // Preserve advanced non-secret fields when editing; this form edits the first credential binding.
                  literalEnv: draft?.literalEnv ?? {},
                  literalHeaders: draft?.literalHeaders ?? {},
                  credentialBindings: [
                    ...(credential
                      ? [
                          {
                            destination: transport === 'stdio' ? ('env' as const) : ('header' as const),
                            key: transport === 'stdio' ? envKey : 'Authorization',
                            credentialRef: credential,
                            format: transport === 'stdio' ? ('raw' as const) : ('bearer' as const),
                          },
                        ]
                      : []),
                    ...(draft?.credentialBindings.slice(1) ?? []),
                  ],
                  enabled,
                },
                draft?.revision ?? 0,
              ),
            );
            setCredentialEpoch((epoch) => epoch + 1);
            setDraft(d);
          });
        }}
      >
        <label>
          {t('integrations.id')}
          <input
            required
            value={definitionId}
            disabled={Boolean(draft)}
            onChange={(e) => setDefinitionId(e.target.value)}
          />
        </label>
        <label>
          {t('integrations.label')}
          <input required value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          {t('connectors.template')}
          <select
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              setServerName(e.target.value);
            }}
          >
            {[...CONNECTOR_TEMPLATES, 'custom'].map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </label>
        <label>
          {t('connectors.namespace')}
          <input required value={serverName} onChange={(e) => setServerName(e.target.value)} />
        </label>
        <label>
          {t('connectors.transport')}
          <select value={transport} onChange={(e) => setTransport(e.target.value as typeof transport)}>
            <option>streamable-http</option>
            <option>stdio</option>
          </select>
        </label>
        <label>
          {t(transport === 'stdio' ? 'connectors.command' : 'connectors.url')}
          <input required value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
        </label>
        {transport === 'stdio' && (
          <>
            <label>
              {t('connectors.args')}
              <textarea value={args} onChange={(e) => setArgs(e.target.value)} />
            </label>
            <label>
              {t('connectors.envKey')}
              <input value={envKey} onChange={(e) => setEnvKey(e.target.value)} />
            </label>
          </>
        )}
        <label>
          {t('connectors.credentialRef')}
          <input
            value={credential}
            onChange={(e) => {
              setCredential(e.target.value);
            }}
          />
        </label>
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('integrations.enabled')}
        </label>
        <button type="submit" disabled={busy}>
          {t('integrations.save')}
        </button>
      </form>
      <CredentialEditor
        key={`${credential}:${credentialEpoch}`}
        actions={actions}
        credential={credential}
        active={active}
        busy={busy}
        perform={perform}
        t={t}
      />
    </>
  );
}
