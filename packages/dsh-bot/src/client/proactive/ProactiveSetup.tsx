import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useRef, useState } from 'react';
import { proactiveSetupRequest, type ProactiveSetupRequest, type ProactiveSetupReply } from '../../shared/proactive/setup.js';
import styles from './workspace.module.css';
import css from './workspace.module.css?inline';

export function ProactiveSetup({ setup, refresh, t }: PropsLocale<'dsh-bot'> & {
  setup?(input: ProactiveSetupRequest): Promise<ProactiveSetupReply>;
  refresh?(): Promise<void>;
}) {
  const [pending, setPending] = useState(false), busy = useRef(false);
  const [message, setMessage] = useState<ProactiveSetupReply | 'unknown'>();
  const [repository, setRepository] = useState(''), [branch, setBranch] = useState('main');
  const [credential, setCredential] = useState('GITHUB_TOKEN');
  const request = { action: 'connect-github' as const, repository, branch, credentialRef: credential };
  async function run(input: Extract<ProactiveSetupRequest, { action: 'connect-github' }>) {
    if (!setup || busy.current) return;
    busy.current = true; setPending(true); setMessage(undefined);
    try { setMessage(await setup(input)); }
    catch { setMessage('unknown'); }
    finally {
      busy.current = false; setPending(false);
      // Native Loader may remount this plugin before the Remote response arrives.
      // Refresh the shared status; never interpret a lost response as success.
      await refresh?.();
    }
  }
  return <div data-proactive-setup className={styles.content}>
    <style>{css}</style>
    <p>{t('proactive.setup.noSource')}</p>
    <details>
      <summary>{t('proactive.setup.connect')}</summary>
      <p>{t('proactive.setup.sourceHint')}</p>
      <fieldset disabled={pending}>
        <label>{t('proactive.setup.repository')}<input autoComplete="off" value={repository} maxLength={201} placeholder="owner/repository" onChange={e => setRepository(e.target.value)} /></label>
        <label>{t('proactive.setup.branch')}<input value={branch} maxLength={200} onChange={e => setBranch(e.target.value)} /></label>
        <label>{t('proactive.setup.credential')}<input autoComplete="off" value={credential} maxLength={128} onChange={e => setCredential(e.target.value)} /></label>
      </fieldset>
      <p>{t('proactive.setup.credentialHint')}</p>
      <Button disabled={pending || !setup || !proactiveSetupRequest.safeParse(request).success} onClick={() => void run(request)}>
        {t(pending ? 'proactive.setup.saving' : 'proactive.setup.saveSource')}
      </Button>
    </details>
    {message && <p role="status">{t(`proactive.setup.${message}`)}</p>}
    {(message === 'unknown' || message === 'updated') && <Button disabled={pending} onClick={() => void refresh?.()}>{t('proactive.refresh')}</Button>}
    {!setup && <p role="status">{t('proactive.setup.unavailable')}</p>}
  </div>;
}
