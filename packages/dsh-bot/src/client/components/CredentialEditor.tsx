import { useEffect, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { IntegrationActions } from '../integrations-state.js';
export function CredentialEditor({
  actions,
  credential,
  active,
  busy,
  perform,
  t,
}: PropsLocale<'dsh-bot'> & {
  actions: IntegrationActions;
  credential: string;
  active: boolean;
  busy: boolean;
  perform(fn: () => Promise<unknown>): Promise<void>;
}) {
  const [secret, setSecret] = useState('');
  const [credentialInfo, setCredentialInfo] = useState<'configured' | 'missing' | 'readonly'>();
  useEffect(() => {
    if (!active) {
      setSecret('');
      setCredentialInfo(undefined);
    }
  }, [active]);
  const nativeCredentials = actions.credentials();
  return (
    <>
      {' '}
      <fieldset disabled={busy || !nativeCredentials}>
        <legend>{t('connectors.nativeCredentials')}</legend>
        <p>{t('connectors.credentialsOneWay')}</p>
        <label>
          {t('connectors.secret')}
          <input
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!nativeCredentials || !credential}
          onClick={() => {
            void perform(async () => {
              const result = await nativeCredentials?.describe([credential]);
              if (!result?.ok) throw new Error('Credential provider unavailable');
              const info = result.value[credential];
              setCredentialInfo(info?.writable === false ? 'readonly' : info?.configured ? 'configured' : 'missing');
            });
          }}
        >
          {t('connectors.describeCredential')}
        </button>
        <button
          type="button"
          disabled={!nativeCredentials || !credential || !secret || credentialInfo === 'readonly'}
          onClick={() => {
            const value = secret;
            setSecret('');
            void perform(async () => {
              const result = await nativeCredentials?.set(credential, value);
              if (!result?.ok) throw new Error('Credential provider unavailable');
              setCredentialInfo('configured');
            });
          }}
        >
          {t('connectors.storeCredential')}
        </button>
        {credentialInfo && <p role="status">{t(`connectors.credential-${credentialInfo}`)}</p>}
      </fieldset>
      {!nativeCredentials && <p>{t('connectors.nativeCredentialsUnavailable')}</p>}
    </>
  );
}
