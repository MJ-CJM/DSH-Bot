import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotRecord } from '../../shared/schema.js';
import { CONNECTOR_TEMPLATES, type Connector, type NotificationPolicy, sameBot } from '../../shared/p34.js';
import type { P34Actions } from '../p34-state.js';
import css from '../styles/p34.module.css?inline';
import styles from '../styles/p34.module.css';
export interface P34PanelProps extends PropsLocale<'dsh-bot'> { actions: P34Actions; bots: BotRecord[]; mode: 'connectors' | 'notifications'; onOpenSession(id: string): Promise<void> }
export function P34Panel({ actions, bots, mode, onOpenSession, t }: P34PanelProps) {
  const snapshot = useSyncExternalStore(actions.catalog.subscribe, actions.catalog.getSnapshot, actions.catalog.getSnapshot);
  const data = snapshot;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [ownerId, setOwnerId] = useState('');
  const bot = bots.find(b => b.id === ownerId) ?? bots[0];
  const owner = bot && { botId: bot.id, botCreatedAt: bot.createdAt };
  const [draft, setDraft] = useState<Connector>();
  const [definitionId, setDefinitionId] = useState('');
  const [label, setLabel] = useState('');
  const [template, setTemplate] = useState('github');
  const [serverName, setServerName] = useState('github');
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('streamable-http');
  const [endpoint, setEndpoint] = useState('');
  const [args, setArgs] = useState('');
  const [credential, setCredential] = useState('');
  const [secret, setSecret] = useState('');
  const [credentialInfo, setCredentialInfo] = useState<'configured' | 'missing' | 'readonly'>();
  const nativeCredentials = actions.credentials();
  useEffect(() => { if (mode !== 'connectors') { setSecret(''); setCredentialInfo(undefined); } }, [mode]);
  const [envKey, setEnvKey] = useState('TOKEN');
  const [enabled, setEnabled] = useState(false);
  const [policy, setPolicy] = useState<NotificationPolicy>();
  const [policyEnabled, setPolicyEnabled] = useState(true);
  const [policyId, setPolicyId] = useState('');
  const [channel, setChannel] = useState<'in-app' | 'im'>('in-app');
  const [target, setTarget] = useState('');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [limit, setLimit] = useState(''); const [cooldown, setCooldown] = useState('');
  const [preapproved, setPreapproved] = useState(false); const [confirmation, setConfirmation] = useState<string>();
  const [filter, setFilter] = useState('all'); const [testText, setTestText] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const [retryOf, setRetryOf] = useState<string>();
  const [testRequest, setTestRequest] = useState<{ id: string; text: string; policyId: string }>();
  useEffect(() => { void actions.catalog.refresh(); }, [actions]);
  // Polling retains drafts and selection; component lifetime rejects late local updates.
  const scopeDraft = JSON.stringify([owner?.botId, owner?.botCreatedAt, policyId, policy?.scopeDigest, channel, target, timezone, start, end, limit, cooldown, preapproved, policyEnabled, testText]);
  const confirmed = confirmation === scopeDraft;
  const setConfirmed = (value: boolean) => setConfirmation(value ? scopeDraft : undefined);
  const perform = async (fn: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(false); try { await fn(); } catch { if (alive.current) setError(true); } finally { if (alive.current) setBusy(false); } };
  const edit = (d?: Connector) => {
    setDraft(d); setDefinitionId(d?.id ?? ''); setLabel(d?.label ?? ''); setTemplate(d?.templateId ?? 'github'); setServerName(d?.serverName ?? 'github');
    setTransport(d?.transport ?? 'streamable-http'); setEndpoint(d?.url ?? d?.command ?? ''); setArgs(d?.args.join('\n') ?? '');
    setSecret(''); setCredentialInfo(undefined); setCredential(d?.credentialBindings[0]?.credentialRef ?? ''); setEnvKey(d?.credentialBindings[0]?.key ?? 'TOKEN'); setEnabled(d?.enabled ?? false);
  };
  const editPolicy = (p?: NotificationPolicy) => {
    setPolicy(p); setPolicyEnabled(p?.enabled ?? true); setPolicyId(p?.id ?? ''); setChannel(p?.channel ?? 'in-app'); setTarget(p?.targetRef ?? ''); setTimezone(p?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    setStart(p?.quietHours?.start ?? ''); setEnd(p?.quietHours?.end ?? ''); setLimit(String(p?.dailyLimit ?? data.defaults.dailyLimit));
    setCooldown(String(p?.cooldownSec ?? data.defaults.cooldownSec)); setPreapproved(p?.authorization.mode === 'preapproved'); setConfirmed(false);
  };
  return <section className={styles.panel} aria-label={t(`p34.${mode}`)}><style>{css}</style>
    <h2>{t(`p34.${mode}`)}</h2>
    {snapshot.error && <p role="alert">{t('p34.loadFailed')}</p>}
    {error && <p role="alert">{t('p34.operationFailed')}</p>}
    <button type="button" disabled={busy} onClick={() => { void actions.catalog.refresh(); }}>{t('bots.refresh')}</button>
    <label>{t('p34.bot')}<select value={bot?.id ?? ''} onChange={e => { setOwnerId(e.target.value); setSecret(''); setCredentialInfo(undefined); setPolicy(undefined); setPolicyId(''); }}>
      {bots.map(b => <option key={b.id} value={b.id}>{b.name} ({b.id})</option>)}
    </select></label>
    {mode === 'connectors' ? <>
      <p>{t('p34.templateHint')}</p><p>{t('p34.credentialsHint')}</p>
      <ul>{data.definitions.map(d => <li key={d.id}><button type="button" onClick={() => edit(d)}>{d.label} · {d.serverName} · v{d.revision}</button>
        {owner && <button type="button" disabled={busy} onClick={() => { void perform(async () => {
          const a = data.assignments.find(a => sameBot(a.bot, owner) && a.connectorId === d.id);
          await actions.write(() => actions.connectors().saveAssignment({ id: a?.id ?? `assignment:${crypto.randomUUID()}`, bot: owner, connectorId: d.id, enabled: !a?.enabled, overrides: a?.overrides ?? {} }, a?.revision ?? 0));
        }); }}>{t(data.assignments.some(a => owner && sameBot(a.bot, owner) && a.connectorId === d.id && a.enabled) ? 'p34.disconnect' : 'p34.assign')}</button>}
      </li>)}</ul>
      <button type="button" onClick={() => edit()}>{t('p34.newConnector')}</button>
      <form onSubmit={e => { e.preventDefault(); void perform(async () => {
        const d = await actions.write(() => actions.connectors().saveDefinition({ id: definitionId, label, templateId: template as Connector['templateId'], templateVersion: 1,
          serverName, transport, ...(transport === 'stdio' ? { command: endpoint, args: args.split('\n').filter(Boolean) } : { url: endpoint }),
          // Preserve advanced non-secret fields when editing; this form edits the first credential binding.
          literalEnv: draft?.literalEnv ?? {}, literalHeaders: draft?.literalHeaders ?? {}, credentialBindings: [
            ...(credential ? [{ destination: transport === 'stdio' ? 'env' as const : 'header' as const, key: transport === 'stdio' ? envKey : 'Authorization', credentialRef: credential, format: transport === 'stdio' ? 'raw' as const : 'bearer' as const }] : []),
            ...(draft?.credentialBindings.slice(1) ?? []),
          ], enabled }, draft?.revision ?? 0)); setDraft(d);
      }); }}>
        <label>{t('p34.id')}<input required value={definitionId} disabled={Boolean(draft)} onChange={e => setDefinitionId(e.target.value)} /></label>
        <label>{t('p34.label')}<input required value={label} onChange={e => setLabel(e.target.value)} /></label>
        <label>{t('p34.template')}<select value={template} onChange={e => { setTemplate(e.target.value); setServerName(e.target.value); }}>{[...CONNECTOR_TEMPLATES, 'custom'].map(id => <option key={id}>{id}</option>)}</select></label>
        <label>{t('p34.namespace')}<input required value={serverName} onChange={e => setServerName(e.target.value)} /></label>
        <label>{t('p34.transport')}<select value={transport} onChange={e => setTransport(e.target.value as typeof transport)}><option>streamable-http</option><option>stdio</option></select></label>
        <label>{t(transport === 'stdio' ? 'p34.command' : 'p34.url')}<input required value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>
        {transport === 'stdio' && <><label>{t('p34.args')}<textarea value={args} onChange={e => setArgs(e.target.value)} /></label><label>{t('p34.envKey')}<input value={envKey} onChange={e => setEnvKey(e.target.value)} /></label></>}
        <label>{t('p34.credentialRef')}<input value={credential} onChange={e => { setCredential(e.target.value); setSecret(''); setCredentialInfo(undefined); }} /></label>
        <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />{t('p34.enabled')}</label>
        <button type="submit" disabled={busy}>{t('p34.save')}</button>
      </form>
      <fieldset disabled={busy || !nativeCredentials}><legend>{t('p34.nativeCredentials')}</legend>
        <p>{t('p34.credentialsOneWay')}</p>
        <label>{t('p34.secret')}<input type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} /></label>
        <button type="button" disabled={!nativeCredentials || !credential} onClick={() => { void perform(async () => {
          const result = await nativeCredentials?.describe([credential]); if (!result?.ok) throw new Error('Credential provider unavailable');
          const info = result.value[credential]; setCredentialInfo(info?.writable === false ? 'readonly' : info?.configured ? 'configured' : 'missing');
        }); }}>{t('p34.describeCredential')}</button>
        <button type="button" disabled={!nativeCredentials || !credential || !secret || credentialInfo === 'readonly'} onClick={() => {
          const value = secret; setSecret('');
          void perform(async () => { const result = await nativeCredentials?.set(credential, value); if (!result?.ok) throw new Error('Credential provider unavailable'); setCredentialInfo('configured'); });
        }}>{t('p34.storeCredential')}</button>
        {credentialInfo && <p role="status">{t(`p34.credential-${credentialInfo}`)}</p>}
      </fieldset>
      {!nativeCredentials && <p>{t('p34.nativeCredentialsUnavailable')}</p>}
      {owner && <><button type="button" disabled={busy} onClick={() => { void perform(() => actions.write(() => actions.connectors().applyIdle(owner))); }}>{t('p34.apply')}</button>
        {bot?.mcpServers.length ? <button type="button" disabled={busy} onClick={() => { void perform(() => actions.write(() => actions.connectors().importLegacy(owner))); }}>{t('p34.importLegacy')}</button> : null}
        <p>{t('p34.firstOpen')}</p>
        <ul>{data.runtime.filter(r => data.assignments.some(a => a.id === r.assignmentId && sameBot(a.bot, owner))).map(r => <li key={`${r.sessionId}:${r.assignmentId}`}>{r.sessionId} · {t(`p34.${r.state}`)} · {r.appliedRevision ?? '—'}/{r.desiredRevision} · {r.toolCount} {r.reasonCode ?? ''}</li>)}</ul>
      </>}
    </> : <>
      <p>{t('p34.scheduleHint')}</p>{Boolean(bot?.channels.length) && <p>{t('p34.legacyChannels')}</p>}<button type="button" disabled>{t('p34.desktopUnsupported')}</button>
      {!data.imSupported && <p>{t('p34.imUnsupported')}</p>}
      <label>{t('p34.filter')}<select value={filter} onChange={e => setFilter(e.target.value)}>{(['all', 'unread', 'suppressed', 'failed'] as const).map(f => <option key={f} value={f}>{t(`p34.${f}`)}</option>)}</select></label>
      <ul>{data.notifications.filter(r => (!owner || sameBot(r.owner, owner)) && (filter === 'all' || filter === 'unread' && r.readAt === undefined || filter === r.state || filter === 'failed' && r.state === 'unknown')).map(r => <li key={r.id}>
        <p>{r.text}</p><p>{t('p34.source')}: {r.source.id}</p><p>{t(`p34.${r.state}`)} {r.reasonCode ?? ''}</p>
        {r.readAt === undefined && <button type="button" disabled={busy} onClick={() => { void perform(() => actions.write(() => actions.notifications().markRead(r.id, r.revision))); }}>{t('p34.markRead')}</button>}
        {r.source.sessionId && <button type="button" onClick={() => { void perform(() => onOpenSession(r.source.sessionId ?? '')); }}>{t('p34.openSession')}</button>}
      </li>)}</ul>
      <h3>{t('p34.policies')}</h3>
      <ul>{data.policies.filter(p => owner && sameBot(p.owner, owner)).map(p => <li key={p.id}><button type="button" onClick={() => editPolicy(p)}>{p.id} · {p.channel} · v{p.revision}</button></li>)}</ul>
      <button type="button" onClick={() => editPolicy()}>{t('p34.newPolicy')}</button>
      <form onSubmit={e => { e.preventDefault(); if (!owner) return; if (Boolean(start) !== Boolean(end)) { setError(true); return; } void perform(async () => {
        const p = await actions.write(() => actions.notifications().savePolicy({ id: policyId, owner, channel, ...(target ? { targetRef: target } : {}), enabled: policyEnabled && (channel === 'in-app' || data.imSupported),
          timezone, ...(start && end ? { quietHours: { start, end } } : {}), dailyLimit: Number(limit || data.defaults.dailyLimit), cooldownSec: Number(cooldown || data.defaults.cooldownSec), authorization: { mode: preapproved ? 'preapproved' : 'ask' } }, policy?.revision ?? 0, confirmed)); setPolicy(p); setConfirmed(false);
      }); }}>
        <label>{t('p34.id')}<input required disabled={Boolean(policy)} value={policyId} onChange={e => setPolicyId(e.target.value)} /></label>
        <label>{t('p34.channel')}<select value={channel} onChange={e => setChannel(e.target.value as typeof channel)}><option>in-app</option><option disabled={!data.imSupported}>im</option></select></label>
        {channel === 'im' && <label>{t('p34.target')}<input value={target} required onChange={e => setTarget(e.target.value)} /></label>}
        <label>{t('p34.timezone')}<input required value={timezone} onChange={e => setTimezone(e.target.value)} /></label>
        <label>{t('p34.quietStart')}<input type="time" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label>{t('p34.quietEnd')}<input type="time" value={end} onChange={e => setEnd(e.target.value)} /></label><p>{t('p34.quietHint')}</p>
        <label>{t('p34.dailyLimit')}<input type="number" min="0" max="1000" value={limit} onChange={e => setLimit(e.target.value)} /></label>
        <label>{t('p34.cooldown')}<input type="number" min="0" max="86400" value={cooldown} onChange={e => setCooldown(e.target.value)} /></label>
        <label><input type="checkbox" checked={policyEnabled} onChange={e => setPolicyEnabled(e.target.checked)} />{t('p34.enablePolicy')}</label>
        <label><input type="checkbox" checked={preapproved} onChange={e => setPreapproved(e.target.checked)} />{t('p34.preapproved')}</label>
        {preapproved && <label><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('p34.confirmScope')}</label>}
        <button type="submit" disabled={busy || !owner}>{t('p34.save')}</button>
      </form>
      {policy && owner && <><label>{t('p34.testText')}<textarea value={testText} onChange={e => { setTestText(e.target.value); setConfirmed(false); }} /></label>
        <p>{policy.targetRef ?? 'in-app'} · {policy.scopeDigest}</p>
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('p34.confirmSend')}</label>
        <button type="button" disabled={busy || !confirmed || !testText} onClick={() => { void perform(async () => {
          const request = testRequest?.text === testText && testRequest.policyId === policy.id ? testRequest : { id: `test:${crypto.randomUUID()}`, text: testText, policyId: policy.id };
          setTestRequest(request);
          await actions.write(() => actions.notifications().test(owner, { operationId: request.id, policyId: policy.id, text: request.text, ...(retryOf ? { relatedId: retryOf } : {}) }, policy.scopeDigest, true));
          setConfirmed(false);
        }); }}>{t('p34.test')}</button>
        <button type="button" onClick={() => { setRetryOf(testRequest?.id); setTestRequest(undefined); setConfirmed(false); }}>{t('p34.newAttempt')}</button></>}
    </>}
  </section>;
}
