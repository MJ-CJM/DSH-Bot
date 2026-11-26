import { useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { IntegrationActions } from '../integrations-state.js';
import { useSettingsDraft } from './SettingsNavigation.js';
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
  useSettingsDraft(Boolean(secret));
  const [credentialInfo, setCredentialInfo] = useState<'configured' | 'missing' | 'readonly'>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
          disabled={busy || !nativeCredentials || !credential}
          onClick={() => {
            if (busy || !nativeCredentials || !credential) return;
            void perform(async () => {
              const result = await nativeCredentials.describe([credential]);
              if (!result?.ok) throw new Error('Credential provider unavailable');
              const info = result.value[credential];
              if (alive.current) setCredentialInfo(info?.writable === false ? 'readonly' : info?.configured ? 'configured' : 'missing');
            });
          }}
        >
          {t('connectors.describeCredential')}
        </button>
        <button
          type="button"
          disabled={busy || !nativeCredentials || !credential || !secret || credentialInfo === 'readonly'}
          onClick={() => {
            if (busy || !nativeCredentials || !credential || !secret || credentialInfo === 'readonly') return;
            const value = secret;
            void perform(async () => {
              const result = await nativeCredentials.set(credential, value);
              if (!result?.ok) throw new Error('Credential provider unavailable');
              if (alive.current) {
                setSecret('');
                setCredentialInfo('configured');
              }
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
