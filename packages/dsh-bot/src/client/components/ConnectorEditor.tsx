import { Button, Input, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives';
import { useCallback, useEffect, useState, useId } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { CONNECTOR_TEMPLATES, type Connector } from '../../shared/integrations.js';
import type { IntegrationActions } from '../integrations-state.js';
import { CredentialEditor } from './CredentialEditor.js';
import { useSettingsDraft } from './SettingsNavigation.js';
export function ConnectorEditor({
  actions,
  definition,
  onCancel,
  onSaved,
  active,
  busy,
  perform,
  t,
}: PropsLocale<'dsh-bot'> & {
  actions: IntegrationActions;
  definition?: Connector;
  onCancel?(): void;
  onSaved?(): void;
  active: boolean;
  busy: boolean;
  perform(fn: () => Promise<unknown>): Promise<void>;
}) {
  const uid = useId();
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
  useSettingsDraft(JSON.stringify([definitionId, label, template, serverName, transport, endpoint, transport === 'stdio' ? args : '', credential, transport === 'stdio' ? envKey : '', enabled]) !==
    JSON.stringify([draft?.id ?? '', draft?.label ?? '', draft?.templateId ?? 'github', draft?.serverName ?? 'github',
      draft?.transport ?? 'streamable-http', draft?.url ?? draft?.command ?? '', draft?.transport === 'stdio' ? draft.args.join('\n') : '',
      draft?.credentialBindings[0]?.credentialRef ?? '', draft?.transport === 'stdio' ? (draft.credentialBindings[0]?.key ?? 'TOKEN') : '', draft?.enabled ?? false]));
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
      <p>{t('connectors.templateHint')}</p>
      <p>{t('connectors.credentialsHint')}</p>
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
            onSaved?.();
          });
        }}
      >
        <fieldset disabled={busy}>
        <label htmlFor={`${uid}-ConnectorEditor-1`}>
          {t('integrations.id')}
          <Input id={`${uid}-ConnectorEditor-1`}
            required
            value={definitionId}
            disabled={Boolean(draft)}
            onChange={(e) => setDefinitionId(e.target.value)}
          />
        </label>
        <label htmlFor={`${uid}-ConnectorEditor-2`}>
          {t('integrations.label')}
          <Input id={`${uid}-ConnectorEditor-2`} required value={label} onChange={(e) => setLabel(e.target.value)} />
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
        <label htmlFor={`${uid}-ConnectorEditor-3`}>
          {t('connectors.namespace')}
          <Input id={`${uid}-ConnectorEditor-3`} required value={serverName} onChange={(e) => setServerName(e.target.value)} />
        </label>
        <label>
          {t('connectors.transport')}
          <select value={transport} onChange={(e) => setTransport(e.target.value as typeof transport)}>
            <option value="streamable-http">{t('connectors.transport.streamable-http')}</option>
            <option value="stdio">{t('connectors.transport.stdio')}</option>
          </select>
        </label>
        <label htmlFor={`${uid}-ConnectorEditor-4`}>
          {t(transport === 'stdio' ? 'connectors.command' : 'connectors.url')}
          <Input id={`${uid}-ConnectorEditor-4`} required value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
        </label>
        {transport === 'stdio' && (
          <>
            <label>
              {t('connectors.args')}
              <textarea value={args} onChange={(e) => setArgs(e.target.value)} />
            </label>
            <label htmlFor={`${uid}-ConnectorEditor-5`}>
              {t('connectors.envKey')}
              <Input id={`${uid}-ConnectorEditor-5`} value={envKey} onChange={(e) => setEnvKey(e.target.value)} />
            </label>
          </>
        )}
        <label htmlFor={`${uid}-ConnectorEditor-6`}>
          {t('connectors.credentialRef')}
          <Input id={`${uid}-ConnectorEditor-6`}
            value={credential}
            onChange={(e) => {
              setCredential(e.target.value);
            }}
          />
        </label>
        <Checkbox checked={enabled} onChange={setEnabled} label={t('integrations.enabled')} />
        <Button variant="primary" type="submit" disabled={busy}>{t('integrations.save')}</Button>
        <Button disabled={busy} onClick={onCancel}>{t('actions.cancel')}</Button>
        </fieldset>
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
