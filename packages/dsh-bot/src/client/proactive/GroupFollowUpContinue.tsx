import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { OwnerFollowUpChoice } from '../../shared/groups.js';
import type { BotKey } from '../../shared/identity.js';
import { subjectKey } from '../../shared/proactive/follow-up.js';
import { followUpGroupAcceptRequestSchema, type FollowUpGroupAcceptRequest, type FollowUpGroupChoiceReply,
  type FollowUpGroupAbandonRequest, type FollowUpGroupChoiceRequest, type FollowUpGroupReply } from '../../shared/proactive/group-follow-up.js';
import type { SuggestionActionReply } from '../../shared/proactive/remote-contract.js';
import styles from './follow-up.module.css';

export interface GroupFollowUpTransport {
  offer(input: FollowUpGroupChoiceRequest): Promise<FollowUpGroupChoiceReply>;
  accept(input: FollowUpGroupAcceptRequest): Promise<FollowUpGroupReply>;
  abandon?(input: FollowUpGroupAbandonRequest): Promise<SuggestionActionReply>;
}
export interface GroupFollowUpMember { id: string; label: string; bot: BotKey }

export function GroupFollowUpContinue({ subject, cardId, turnId, revision, policyRevision, members, active, enabled,
  transport, onAccepted, onAbandoned, t }: PropsLocale<'dsh-bot'> & {
  subject: FollowUpGroupChoiceRequest['subject'];
  cardId: string;
  turnId: string;
  revision: number;
  policyRevision: number;
  members: readonly GroupFollowUpMember[];
  active: boolean;
  enabled: boolean;
  transport: GroupFollowUpTransport;
  onAccepted(turnId: string): void;
  onAbandoned?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [memberId, setMemberId] = useState('');
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<OwnerFollowUpChoice>();
  const [pending, setPending] = useState<FollowUpGroupAcceptRequest>();
  const [state, setState] = useState<'loading' | 'accepting' | 'unknown' | 'error' | 'started' | 'abandoned'>();
  const [canAbandon, setCanAbandon] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [abandonment, setAbandonment] = useState<FollowUpGroupAbandonRequest>();
  const scope = useRef(0);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const memberSelect = useRef<HTMLSelectElement>(null);
  const busy = state === 'loading' || state === 'accepting';
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!active) setState(current => current === 'loading' ? undefined : current);
    return () => { scope.current++; };
  }, [active]);
  useEffect(() => { if (open && active) memberSelect.current?.focus(); }, [open, active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each revision invalidates prepared choices and outstanding reads, without inspecting the new revision values.
  useEffect(() => {
    scope.current++;
    setChoice(undefined);
    setState(current => current === 'loading' || current === 'abandoned' ? undefined : current);
  }, [revision, policyRevision]);

  const load = async (id: string) => {
    const request = ++scope.current;
    setMemberId(id);
    setChoice(undefined);
    setState(undefined);
    setCanAbandon(false);
    setConfirmAbandon(false);
    const member = members.find(row => row.id === id);
    if (!member || !active || !enabled) return;
    setState('loading');
    try {
      const result = await transport.offer({ subject, cardId, expectedRevision: revision, memberId: member.id });
      if (request !== scope.current) return;
      if (result.existing) {
        const original = result.existing;
        if (original.cardId !== cardId ||
            subjectKey(original.subject) !== subjectKey(subject) || original.choice.predecessorTurnId !== turnId)
          throw new Error('Group continuation owner mismatch');
        setMemberId(original.choice.memberId);
        setPending(original);
        setCanAbandon(result.canAbandon === true);
        setState('unknown');
        return;
      }
      if (result.choice.predecessorTurnId !== turnId || result.choice.memberId !== member.id || result.choice.bot.botId !== member.bot.botId ||
          result.choice.bot.botCreatedAt !== member.bot.botCreatedAt) throw new Error('Group continuation member mismatch');
      setChoice(result.choice);
      setState(undefined);
    } catch {
      if (request === scope.current) setState('error');
    }
  };
  const accept = async (input: FollowUpGroupAcceptRequest) => {
    if (!active || submitting.current) return;
    const request = scope.current;
    submitting.current = true;
    setPending(input);
    setState('accepting');
    setConfirmAbandon(false);
    let started: string | undefined;
    let refreshProof = false;
    try {
      const reply = await transport.accept(input);
      if (!mounted.current) return;
      if (reply.kind === 'rejected') {
        setPending(undefined);
        setChoice(undefined);
        setState('error');
      } else if (reply.commandId !== input.commandId || reply.kind === 'unknown') {
        setState('unknown');
        refreshProof = true;
      } else {
        setPending(undefined);
        setState('started');
        started = reply.turnId;
      }
    } catch { if (mounted.current) { setState('unknown'); refreshProof = true; } }
    finally { submitting.current = false; }
    if (refreshProof) {
      const result = await transport.offer({ subject, cardId, expectedRevision: input.expectedRevision, memberId: input.choice.memberId })
        .catch(() => undefined);
      if (mounted.current && request === scope.current && !submitting.current)
        setCanAbandon(result?.canAbandon === true && result.existing?.commandId === input.commandId);
    }
    if (started && request === scope.current) onAccepted(started);
  };
  const abandon = async (input: FollowUpGroupAbandonRequest) => {
    if (!active || !transport.abandon || submitting.current) return;
    submitting.current = true;
    setAbandonment(input);
    setState('accepting');
    try {
      const result = await transport.abandon(input);
      if (!mounted.current) return;
      if (result.kind === 'unknown') setState('unknown');
      else {
        setAbandonment(undefined); setConfirmAbandon(false); setCanAbandon(false);
        if (result.kind === 'rejected') setState('error');
        else {
          setPending(undefined); setMemberId(''); setChoice(undefined); setText('');
          setState('abandoned'); onAbandoned?.();
        }
      }
    } catch { if (mounted.current) setState('unknown'); }
    finally { submitting.current = false; }
  };
  const draft = followUpGroupAcceptRequestSchema.shape.text.safeParse(text);
  const valid = choice && members.some(member => member.id === choice.memberId && member.bot.botId === choice.bot.botId &&
    member.bot.botCreatedAt === choice.bot.botCreatedAt) && draft.success;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!enabled || busy || pending || !valid || !choice || !draft.success) return;
    void accept({ commandId: crypto.randomUUID(), subject, cardId, expectedRevision: revision,
      expectedPolicyRevision: policyRevision, choice, text: draft.data, approved: true });
  };
  const selectedChoice = pending?.choice ?? choice;
  if (state === 'started') return <p role="status">{t('followUp.groupStarted')}</p>;
  if (state === 'abandoned') return <p role="status">{t('followUp.groupAbandoned')}</p>;
  if (!open) return <Button size="sm" variant="ghost" disabled={!active || !enabled || members.length === 0}
    onClick={() => setOpen(true)}>{t('followUp.groupContinue')}</Button>;
  return <form className={styles.form} onSubmit={submit}>
    <fieldset disabled={!active || !enabled || state === 'accepting' || !!pending}>
      <legend>{t('followUp.groupContinue')}</legend>
      <label>{t('followUp.groupMember')}<select ref={memberSelect} required value={memberId} onChange={event => void load(event.target.value)}>
        <option value="">{t('followUp.groupChooseMember')}</option>
        {members.map(member => <option value={member.id} key={member.id}>{member.label}</option>)}
      </select></label>
      <label>{t('followUp.groupText')}<textarea required rows={3} maxLength={followUpGroupAcceptRequestSchema.shape.text.maxLength ?? undefined}
        value={pending?.text ?? text} onChange={event => setText(event.target.value)} /></label>
    </fieldset>
    {selectedChoice && <p className={styles.meta}>{t('followUp.groupRoute', {
      member: members.find(member => member.id === selectedChoice.memberId)?.label ?? selectedChoice.bot.botId,
      provider: selectedChoice.modelSelection.provider, model: selectedChoice.modelSelection.model,
    })}</p>}
    {(state === 'loading' || state === 'accepting') && <p className={styles.notice} role="status">
      {t(state === 'loading' ? 'followUp.loading' : 'followUp.saving')}</p>}
    {state === 'unknown' && <p className={styles.notice} role="status">{t('followUp.unknown')}</p>}
    {state === 'error' && <p className={styles.notice} role="alert">{t('followUp.rejected')}</p>}
    <div className={styles.rowActions}>
      {pending ? <Button type="button" size="sm" variant="outline" disabled={!active || busy}
        onClick={() => void (abandonment ? abandon(abandonment) : accept(pending))}>{t('followUp.recheck')}</Button>
        : <Button type="submit" size="sm" variant="primary" disabled={!enabled || !active || busy || !valid}>
          {t('followUp.groupAccept')}</Button>}
      {pending && !abandonment && canAbandon && transport.abandon &&
        (confirmAbandon ? <Button type="button" size="sm" variant="outline" disabled={!active || busy}
          onClick={() => void abandon({ commandId: crypto.randomUUID(), subject, cardId, expectedRevision: pending.expectedRevision,
            operationId: pending.commandId, approved: true })}>{t('followUp.groupConfirmAbandon')}</Button>
          : <Button type="button" size="sm" variant="ghost" disabled={!active || busy}
            onClick={() => setConfirmAbandon(true)}>{t('followUp.groupAbandon')}</Button>)}
      {!pending && !choice && memberId && state !== 'loading' && <Button type="button" size="sm" variant="ghost"
        disabled={!enabled || !active} onClick={() => void load(memberId)}>{t('followUp.refresh')}</Button>}
      {!pending && <Button type="button" size="sm" variant="ghost" onClick={() => {
        scope.current++; setOpen(false); setMemberId(''); setChoice(undefined); setState(undefined);
      }}>{t('actions.cancel')}</Button>}
    </div>
  </form>;
}
