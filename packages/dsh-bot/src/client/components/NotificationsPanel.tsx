import { Button, Input, Checkbox, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives';
import { useSettingsDraft, useSettingsLeave } from './SettingsNavigation.js';
import { useState, useId } from 'react';
import { type NotificationPolicy, sameBot } from '../../shared/integrations.js';
import { IntegrationFrame, useIntegrationPanel, type IntegrationPanelProps } from './IntegrationFrame.js';
export function NotificationsPanel(props: IntegrationPanelProps) {
  const { actions, t, onOpenSession } = props;
  const state = useIntegrationPanel(actions, props.bots);
  const { data, bot, owner, busy, perform, setError } = state;
  const uid = useId();
  const [section, setSection] = useState<'records' | 'policies'>('records');
  const leave = useSettingsLeave();
  const [editing, setEditing] = useState(false);
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
  const formValue = JSON.stringify([policyId, policyEnabled, channel, target, timezone, start, end, limit, cooldown, preapproved]);
  const [savedForm, setSavedForm] = useState(formValue);
  useSettingsDraft((editing && formValue !== savedForm) || Boolean(testText));
  const confirmed = confirmation === scopeDraft;
  const setConfirmed = (value: boolean) => setConfirmation(value ? scopeDraft : undefined);
  const editPolicy = (p?: NotificationPolicy) => {
    setSavedForm(JSON.stringify([p?.id ?? '', p?.enabled ?? true, p?.channel ?? 'in-app', p?.targetRef ?? '', p?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, p?.quietHours?.start ?? '', p?.quietHours?.end ?? '', String(p?.dailyLimit ?? data.defaults.dailyLimit), String(p?.cooldownSec ?? data.defaults.cooldownSec), p?.authorization.mode === 'preapproved']));
    setSection('policies'); setEditing(true);
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
        editPolicy(); setTestText(''); setTestRequest(undefined); setRetryOf(undefined);
      }}
    >
      <div>
        <SegmentedTabs label={t('notifications.notifications')} value={section} onChange={setSection} items={[{ value: 'records', id: `${uid}-records`, panelId: `${uid}-records-panel`, label: t('notifications.records') }, { value: 'policies', id: `${uid}-policies`, panelId: `${uid}-policies-panel`, label: t('notifications.policies') }]} />
        <Button variant="primary" disabled={busy || !owner} onClick={() => leave(() => editPolicy())}>{t('notifications.newPolicy')}</Button>
      </div>
      <section role="tabpanel" id={`${uid}-records-panel`} aria-labelledby={`${uid}-records`} hidden={section !== 'records'} aria-label={t('notifications.records')}>
      {!data.notifications.some(r => owner && sameBot(r.owner, owner) && (filter === 'all' || (filter === 'unread' && r.readAt === undefined) || filter === r.state || (filter === 'failed' && r.state === 'unknown'))) && <p>{t('notifications.emptyRecords')}</p>}
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
              (owner && sameBot(r.owner, owner)) &&
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
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void perform(() => actions.write(() => actions.notifications().markRead(r.id, r.revision)));
                  }}
                >
                  {t('notifications.markRead')}
                </Button>
              )}
              {r.source.sessionId && (
                <Button
                  type="button"
                  onClick={() => {
                    void perform(() => onOpenSession(r.source.sessionId ?? ''));
                  }}
                >
                  {t('notifications.openSession')}
                </Button>
              )}
            </li>
          ))}
      </ul>
      </section>
      <section role="tabpanel" id={`${uid}-policies-panel`} aria-labelledby={`${uid}-policies`} hidden={section !== 'policies'} aria-label={t('notifications.policies')}>
      <p>{t('notifications.scheduleHint')}</p>
      <p>{t('notifications.desktopUnsupported')}</p>
      {!data.imSupported && <p>{t('notifications.imUnsupported')}</p>}
      {Boolean(bot?.channels.length) && <details><summary>{t('settings.diagnostics')}</summary><p>{t('notifications.legacyChannels')}</p></details>}
      <h3>{t('notifications.policies')}</h3>
      {!data.policies.some(p => owner && sameBot(p.owner, owner)) && <p>{t('notifications.emptyPolicies')}</p>}
      <ul>
        {data.policies
          .filter((p) => owner && sameBot(p.owner, owner))
          .map((p) => (
            <li key={p.id}>
              <Button type="button" disabled={busy} onClick={() => leave(() => editPolicy(p))}>
                {p.id} · {p.channel} · v{p.revision}
              </Button>
            </li>
          ))}
      </ul>
      {editing && <form
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
            setSavedForm(formValue);
            setEditing(false);
            setConfirmed(false);
          });
        }}
      >
        <fieldset disabled={busy}>
        <label htmlFor={`${uid}-NotificationsPanel-1`}>
          {t('integrations.id')}
          <Input id={`${uid}-NotificationsPanel-1`} required disabled={Boolean(policy)} value={policyId} onChange={(e) => setPolicyId(e.target.value)} />
        </label>
        <label>
          {t('notifications.channel')}
          <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            <option>in-app</option>
            <option disabled={!data.imSupported}>im</option>
          </select>
        </label>
        {channel === 'im' && (
          <label htmlFor={`${uid}-NotificationsPanel-2`}>
            {t('notifications.target')}
            <Input id={`${uid}-NotificationsPanel-2`} value={target} required onChange={(e) => setTarget(e.target.value)} />
          </label>
        )}
        <label htmlFor={`${uid}-NotificationsPanel-3`}>
          {t('notifications.timezone')}
          <Input id={`${uid}-NotificationsPanel-3`} required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
        <label htmlFor={`${uid}-NotificationsPanel-4`}>
          {t('notifications.quietStart')}
          <Input id={`${uid}-NotificationsPanel-4`} type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label htmlFor={`${uid}-NotificationsPanel-5`}>
          {t('notifications.quietEnd')}
          <Input id={`${uid}-NotificationsPanel-5`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <p>{t('notifications.quietHint')}</p>
        <label htmlFor={`${uid}-NotificationsPanel-6`}>
          {t('notifications.dailyLimit')}
          <Input id={`${uid}-NotificationsPanel-6`} type="number" min="0" max="1000" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </label>
        <label htmlFor={`${uid}-NotificationsPanel-7`}>
          {t('notifications.cooldown')}
          <Input id={`${uid}-NotificationsPanel-7`} type="number" min="0" max="86400" value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
        </label>
        <Checkbox checked={policyEnabled} onChange={setPolicyEnabled} label={t('notifications.enablePolicy')} />
        <Checkbox checked={preapproved} onChange={setPreapproved} label={t('notifications.preapproved')} />
        {preapproved && (
          <label>
            <input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t('notifications.confirmScope')}
          </label>
        )}
        <Button variant="primary" type="submit" disabled={busy || !owner}>{t('integrations.save')}</Button>
        <Button disabled={busy} onClick={() => leave(() => { setEditing(false); setPolicy(undefined); setTestText(''); })}>{t('actions.cancel')}</Button>
        </fieldset>
      </form>}
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
          <p data-notification-test-target="">
            {t('notifications.testTarget', {
              target: policy.targetRef ?? t('notifications.inApp'),
              channel: policy.channel,
            })}
          </p>
          <details data-notification-scope-details="">
            <summary>{t('settings.diagnostics')}</summary>
            <p>
              {t('notifications.scopeDigestLabel')}: <code>{policy.scopeDigest}</code>
            </p>
          </details>
          <label>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t('notifications.confirmSend')}
          </label>
          <Button
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
          </Button>
          <Button
            type="button"
            onClick={() => {
              setRetryOf(testRequest?.id);
              setTestRequest(undefined);
              setConfirmed(false);
            }}
          >
            {t('notifications.newAttempt')}
          </Button>
        </>
      )}
      </section>
    </IntegrationFrame>
  );
}
