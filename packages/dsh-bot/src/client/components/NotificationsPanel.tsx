import { useState } from 'react';
import { type NotificationPolicy, sameBot } from '../../shared/integrations.js';
import { IntegrationFrame, useIntegrationPanel, type IntegrationPanelProps } from './IntegrationFrame.js';
export function NotificationsPanel(props: IntegrationPanelProps) {
  const { actions, t, onOpenSession } = props;
  const state = useIntegrationPanel(actions, props.bots);
  const { data, bot, owner, busy, perform, setError } = state;
  const [policy, setPolicy] = useState<NotificationPolicy>();
  const [policyEnabled, setPolicyEnabled] = useState(true);
  const [policyId, setPolicyId] = useState('');
  const [channel, setChannel] = useState<'in-app' | 'im'>('in-app');
  const [target, setTarget] = useState('');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [limit, setLimit] = useState('');
  const [cooldown, setCooldown] = useState('');
  const [preapproved, setPreapproved] = useState(false);
  const [confirmation, setConfirmation] = useState<string>();
  const [filter, setFilter] = useState('all');
  const [testText, setTestText] = useState('');
  const [retryOf, setRetryOf] = useState<string>();
  const [testRequest, setTestRequest] = useState<{ id: string; text: string; policyId: string }>();
  const scopeDraft = JSON.stringify([
    owner?.botId,
    owner?.botCreatedAt,
    policyId,
    policy?.scopeDigest,
    channel,
    target,
    timezone,
    start,
    end,
    limit,
    cooldown,
    preapproved,
    policyEnabled,
    testText,
  ]);
  const confirmed = confirmation === scopeDraft;
  const setConfirmed = (value: boolean) => setConfirmation(value ? scopeDraft : undefined);
  const editPolicy = (p?: NotificationPolicy) => {
    setPolicy(p);
    setPolicyEnabled(p?.enabled ?? true);
    setPolicyId(p?.id ?? '');
    setChannel(p?.channel ?? 'in-app');
    setTarget(p?.targetRef ?? '');
    setTimezone(p?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    setStart(p?.quietHours?.start ?? '');
    setEnd(p?.quietHours?.end ?? '');
    setLimit(String(p?.dailyLimit ?? data.defaults.dailyLimit));
    setCooldown(String(p?.cooldownSec ?? data.defaults.cooldownSec));
    setPreapproved(p?.authorization.mode === 'preapproved');
    setConfirmed(false);
  };
  return (
    <IntegrationFrame
      {...props}
      state={state}
      title="notifications"
      onOwnerChange={() => {
        setPolicy(undefined);
        setPolicyId('');
      }}
    >
      <p>{t('notifications.scheduleHint')}</p>
      {Boolean(bot?.channels.length) && <p>{t('notifications.legacyChannels')}</p>}
      <p>{t('notifications.desktopUnsupported')}</p>
      {!data.imSupported && <p>{t('notifications.imUnsupported')}</p>}
      <label>
        {t('notifications.filter')}
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {(['all', 'unread', 'suppressed', 'failed'] as const).map((f) => (
            <option key={f} value={f}>
              {t(`notifications.${f}`)}
            </option>
          ))}
        </select>
      </label>
      <ul>
        {data.notifications
          .filter(
            (r) =>
              (!owner || sameBot(r.owner, owner)) &&
              (filter === 'all' ||
                (filter === 'unread' && r.readAt === undefined) ||
                filter === r.state ||
                (filter === 'failed' && r.state === 'unknown')),
          )
          .map((r) => (
            <li key={r.id}>
              <p>{r.text}</p>
              <p>
                {t('notifications.source')}: {r.source.id}
              </p>
              <p>
                {t(`notifications.${r.state}`)} {r.reasonCode ?? ''}
              </p>
              {r.readAt === undefined && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void perform(() => actions.write(() => actions.notifications().markRead(r.id, r.revision)));
                  }}
                >
                  {t('notifications.markRead')}
                </button>
              )}
              {r.source.sessionId && (
                <button
                  type="button"
                  onClick={() => {
                    void perform(() => onOpenSession(r.source.sessionId ?? ''));
                  }}
                >
                  {t('notifications.openSession')}
                </button>
              )}
            </li>
          ))}
      </ul>
      <h3>{t('notifications.policies')}</h3>
      <ul>
        {data.policies
          .filter((p) => owner && sameBot(p.owner, owner))
          .map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => editPolicy(p)}>
                {p.id} · {p.channel} · v{p.revision}
              </button>
            </li>
          ))}
      </ul>
      <button type="button" onClick={() => editPolicy()}>
        {t('notifications.newPolicy')}
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!owner) return;
          if (Boolean(start) !== Boolean(end)) {
            setError(true);
            return;
          }
          void perform(async () => {
            const p = await actions.write(() =>
              actions.notifications().savePolicy(
                {
                  id: policyId,
                  owner,
                  channel,
                  ...(target ? { targetRef: target } : {}),
                  enabled: policyEnabled && (channel === 'in-app' || data.imSupported),
                  timezone,
                  ...(start && end ? { quietHours: { start, end } } : {}),
                  dailyLimit: Number(limit || data.defaults.dailyLimit),
                  cooldownSec: Number(cooldown || data.defaults.cooldownSec),
                  authorization: { mode: preapproved ? 'preapproved' : 'ask' },
                },
                policy?.revision ?? 0,
                confirmed,
              ),
            );
            setPolicy(p);
            setConfirmed(false);
          });
        }}
      >
        <label>
          {t('integrations.id')}
          <input required disabled={Boolean(policy)} value={policyId} onChange={(e) => setPolicyId(e.target.value)} />
        </label>
        <label>
          {t('notifications.channel')}
          <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            <option>in-app</option>
            <option disabled={!data.imSupported}>im</option>
          </select>
        </label>
        {channel === 'im' && (
          <label>
            {t('notifications.target')}
            <input value={target} required onChange={(e) => setTarget(e.target.value)} />
          </label>
        )}
        <label>
          {t('notifications.timezone')}
          <input required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
        <label>
          {t('notifications.quietStart')}
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          {t('notifications.quietEnd')}
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <p>{t('notifications.quietHint')}</p>
        <label>
          {t('notifications.dailyLimit')}
          <input type="number" min="0" max="1000" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </label>
        <label>
          {t('notifications.cooldown')}
          <input type="number" min="0" max="86400" value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={policyEnabled} onChange={(e) => setPolicyEnabled(e.target.checked)} />
          {t('notifications.enablePolicy')}
        </label>
        <label>
          <input type="checkbox" checked={preapproved} onChange={(e) => setPreapproved(e.target.checked)} />
          {t('notifications.preapproved')}
        </label>
        {preapproved && (
          <label>
            <input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t('notifications.confirmScope')}
          </label>
        )}
        <button type="submit" disabled={busy || !owner}>
          {t('integrations.save')}
        </button>
      </form>
      {policy && owner && (
        <>
          <label>
            {t('notifications.testText')}
            <textarea
              value={testText}
              onChange={(e) => {
                setTestText(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <p>
            {policy.targetRef ?? 'in-app'} · {policy.scopeDigest}
          </p>
          <label>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t('notifications.confirmSend')}
          </label>
          <button
            type="button"
            disabled={busy || !confirmed || !testText}
            onClick={() => {
              void perform(async () => {
                const request =
                  testRequest?.text === testText && testRequest.policyId === policy.id
                    ? testRequest
                    : { id: `test:${crypto.randomUUID()}`, text: testText, policyId: policy.id };
                setTestRequest(request);
                await actions.write(() =>
                  actions.notifications().test(
                    owner,
                    {
                      operationId: request.id,
                      policyId: policy.id,
                      text: request.text,
                      ...(retryOf ? { relatedId: retryOf } : {}),
                    },
                    policy.scopeDigest,
                    true,
                  ),
                );
                setConfirmed(false);
              });
            }}
          >
            {t('notifications.test')}
          </button>
          <button
            type="button"
            onClick={() => {
              setRetryOf(testRequest?.id);
              setTestRequest(undefined);
              setConfirmed(false);
            }}
          >
            {t('notifications.newAttempt')}
          </button>
        </>
      )}
    </IntegrationFrame>
  );
}
