import { platformSchema } from '../../shared/capabilities-contract.js';
import { useEffect, useMemo, useState } from 'react';
import type { BotRecord } from '../../shared/schema.js';
import type { ModelActions } from '../model-catalog-state.js';
import styles from '../styles/capabilities.module.css';
import css from '../styles/capabilities.module.css?inline';
export type CapabilityKey = `capabilities.${'title' | 'refresh' | 'online' | 'offline' | 'loadedSkills' | 'ownSkills' | 'configuredDirs' | 'tools' | 'toolsHint' | 'unavailable' | 'empty' | 'new' | 'edit' | 'remove' | 'removeConfirm' | 'name' | 'content' | 'save' | 'cancel' | 'error' | 'saved' | 'modelCatalog' | 'modelManual' | 'modelUnavailable' | 'modelUnknown' | 'modelLoaded' | 'modelDefault' | 'chooseDirectory' | 'catalogModel' | 'reasoningDefault' | 'skillHint' | 'skillDescription' | 'browser' | 'browserBlocked' | 'browserConnector' | 'voice' | 'voiceSetup' | 'voiceReady' | 'voiceNotReady' | 'dataFlow' | 'flowRestricted' | 'flowScoped' | 'flowUnavailable' | 'freshConversation' | 'freshConfirm' | 'freshHint' | 'freshError'}`;
export function CapabilitiesPanel({ bot, actions, t }: { bot: BotRecord; actions: ModelActions; t: (key: CapabilityKey) => string }) {
  const identity = `${bot.id}/${bot.createdAt}`;
  const epoch = useMemo(() => ({ live: true, identity }), [identity]);
  useEffect(() => { epoch.live = true; return () => { epoch.live = false; }; }, [epoch]);
  const isCurrent = () => epoch.live;
  const [data, setData] = useState<Awaited<ReturnType<ModelActions['inspect']>>>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [saved, setSaved] = useState(false);
  const [freshError, setFreshError] = useState(false);
  const [edit, setEdit] = useState<{ name: string; content: string; hash: string | null }>();
  useEffect(() => { if (!epoch.live) return; setData(undefined); setEdit(undefined); setError(false); setBusy(false); setSaved(false); setFreshError(false); }, [epoch]);
  useEffect(() => { let active = true;
    void actions.inspect({ id: bot.id, createdAt: bot.createdAt }).then(value => { if (active) setData(value); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [actions, bot.id, bot.createdAt]);
  const platform = platformSchema.parse(data?.platform);
  const run = async (action: () => Promise<void>) => { setError(false); setSaved(false); setBusy(true);
    try { await action(); } catch { if (isCurrent()) setError(true); } finally { if (isCurrent()) setBusy(false); } };
  return <details className={styles.panel}>
    <summary>{t('capabilities.title')}</summary>
    <style>{css}</style><section aria-label={t('capabilities.title')}>
    <button type="button" disabled={busy} onClick={() => { void run(async () => { const value = await actions.inspect(bot); if (isCurrent()) setData(value); }); }}>{t('capabilities.refresh')}</button>
    {error && <p role="alert">{t('capabilities.error')}</p>}{saved && <p role="status">{t('capabilities.saved')}</p>}
    {data && <>
      <p>{t(data.online ? 'capabilities.online' : 'capabilities.offline')}</p>
      <section aria-label={t('capabilities.dataFlow')}>
        <h4>{t('capabilities.dataFlow')}</h4>
        <p>{t(data.dataFlow?.state === 'clear' ? 'capabilities.flowScoped' :
          data.dataFlow?.state === 'restricted' || data.dataFlow?.reasons.some(reason => reason !== 'unavailable')
            ? 'capabilities.flowRestricted' : 'capabilities.flowUnavailable')}</p>
        <p>{t('capabilities.freshHint')}</p>
        <button type="button" disabled={busy} onClick={() => {
          if (!window.confirm(t('capabilities.freshConfirm'))) return;
          setFreshError(false); setBusy(true);
          const expected = data.mainSessionId ?? null;
          void actions.freshConversation(bot, expected).then(async sessionId => {
            if (!isCurrent()) return;
            actions.openConversation(sessionId);
            const value = await actions.inspect(bot); if (isCurrent()) setData(value);
          }).catch(() => { if (isCurrent()) setFreshError(true); }).finally(() => { if (isCurrent()) setBusy(false); });
        }}>{t('capabilities.freshConversation')}</button>
        {freshError && <p role="alert">{t('capabilities.freshError')}</p>}
      </section>
      <h4>{t('capabilities.loadedSkills')}</h4>
      {!data.skillsAvailable ? <p>{t('capabilities.unavailable')}</p> : <ul>{data.skills.length ? data.skills.map(skill => <li key={skill.name}><strong>{skill.name}</strong> · {skill.description} ({skill.provider})</li>) : <li>{t('capabilities.empty')}</li>}</ul>}
      <h4>{t('capabilities.configuredDirs')}</h4><ul>{data.extraDirs.length ? data.extraDirs.map(path => <li key={path}>{path}</li>) : <li>{t('capabilities.empty')}</li>}</ul>
      <h4>{t('capabilities.ownSkills')}</h4><p>{t('capabilities.skillHint')}</p>
      <ul>{data.ownSkills.map(name => <li key={name}>{name}{' '}
        <button type="button" disabled={busy} onClick={() => { void run(async () => { const skill = await actions.readSkill(bot, name); if (!isCurrent()) return; setEdit({ name, content: skill.content ?? '', hash: skill.hash }); }); }}>{t('capabilities.edit')}</button>
      </li>)}</ul>
      <button type="button" disabled={busy} onClick={() => setEdit({ name: 'my-skill', content: `---\nname: my-skill\ndescription: ${JSON.stringify(t('capabilities.skillDescription'))}\n---\n\n`, hash: null })}>{t('capabilities.new')}</button>
      <h4>{t('capabilities.browser')}</h4>
      <p>{platform.browser.provider ?? t('capabilities.unavailable')} · {t('capabilities.browserBlocked')}</p>
      <p>{t('capabilities.browserConnector')}</p>
      <h4>{t('capabilities.voice')}</h4>
      <p>{t(platform.voice.available && platform.voice.providers.some(provider => provider.id === platform.voice.selectedProvider && provider.phase === 'ready') ? 'capabilities.voiceReady' : 'capabilities.voiceNotReady')}</p>
      <ul>{platform.voice.providers.map(provider => <li key={provider.id}>{provider.name}</li>)}</ul>
      <p>{t('capabilities.voiceSetup')}</p>
      <h4>{t('capabilities.tools')}</h4><p>{t('capabilities.toolsHint')}</p><ul>{data.tools.map(name => <li key={name}>{name}</li>)}</ul>
    </>}
    {edit && <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const result = await actions.writeSkill(bot, edit.name, edit.content, edit.hash);
      if (!isCurrent()) return;
      setEdit({ name: edit.name, content: result.content ?? edit.content, hash: result.hash }); setSaved(true); const value = await actions.inspect(bot); if (isCurrent()) setData(value);
    }); }}>
      <label>{t('capabilities.name')}<input required pattern="[a-z][a-z0-9-]{0,63}" value={edit.name} readOnly={edit.hash !== null} disabled={busy}
        onChange={event => { const name = event.target.value; setEdit({ ...edit, name, content: edit.content.replace(/^name: .*$/mu, `name: ${name}`) }); }} /></label>
      <label>{t('capabilities.content')}<textarea required rows={12} value={edit.content} disabled={busy} onChange={event => setEdit({ ...edit, content: event.target.value })} /></label>
      <button type="submit" disabled={busy}>{t('capabilities.save')}</button>
      {edit.hash !== null && <button type="button" disabled={busy} onClick={() => { if (window.confirm(t('capabilities.removeConfirm'))) void run(async () => {
        await actions.removeSkill(bot, edit.name, edit.hash as string); if (!isCurrent()) return; setEdit(undefined); const value = await actions.inspect(bot); if (isCurrent()) setData(value);
      }); }}>{t('capabilities.remove')}</button>}
      <button type="button" disabled={busy} onClick={() => setEdit(undefined)}>{t('capabilities.cancel')}</button>
    </form>}
  </section></details>;
}
