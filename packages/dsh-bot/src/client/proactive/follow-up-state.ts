import type { Context } from '@deepseek-ai/cordis';
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { useSyncExternalStore } from 'react';
import {
  followUpPageSchema, followUpSummarySchema, subjectKey,
  type FollowUpAction, type FollowUpOrigin, type FollowUpPageRequest, type FollowUpWatchCreate, type Subject,
} from '../../shared/proactive/follow-up.js';
import type { SuggestionActionReply } from '../../shared/proactive/remote-contract.js';
import { followUpGroupChoiceReplySchema, followUpGroupReplySchema } from '../../shared/proactive/group-follow-up.js';
import { followUpStatusReply, type FollowUpPolicyRequest, type FollowUpStatusReply } from '../../shared/proactive/setup.js';
import { createPollingCatalog, type BotCatalogOptions, type PollingCatalog } from '../state.js';
import type { GroupFollowUpTransport } from './GroupFollowUpContinue.js';

export type FollowUpStatus = FollowUpStatusReply;
export type FollowUpCommand =
  | { kind: 'policy'; input: FollowUpPolicyRequest }
  | { kind: 'watch'; input: FollowUpWatchCreate & { commandId: string } }
  | { kind: 'card'; input: FollowUpAction & { commandId: string } };
type FollowUpPage = ReturnType<typeof followUpPageSchema.parse>;
type Catalog = PollingCatalog<{ status?: FollowUpStatus }>;
type PageCatalog = PollingCatalog<{ page?: FollowUpPage }>;

export interface FollowUpSource {
  summary(subject: Subject): Catalog;
  firstPage(subject: Subject): PageCatalog;
  page(request: FollowUpPageRequest): Promise<FollowUpPage>;
  pending(subject: Subject): FollowUpCommand | undefined;
  run(command: FollowUpCommand): Promise<SuggestionActionReply>;
  groupContinuation?: GroupFollowUpTransport;
  openSession(origin: FollowUpOrigin, signal: AbortSignal): void;
}
export function followUpSessionTarget(origin: FollowUpOrigin): SessionId | SubagentAddress | undefined {
  if (origin.kind === 'native-subagent') return {
    parentSessionId: origin.sessionId as SessionId, childSessionId: origin.childSessionId as SessionId, mode: 'unknown',
  };
  if (origin.kind === 'delegate' || origin.kind === 'team-task') return origin.sessionId as SessionId | undefined;
}
const unwrap = <T>(result: RemoteResult<T>): T => { if (!result.ok) throw result.error; return result.value; };
export function createFollowUpSource(ctx: Context, options: BotCatalogOptions): FollowUpSource {
  const summaries = new Map<string, Catalog>();
  const pages = new Map<string, PageCatalog>();
  const pending = new Map<string, FollowUpCommand>();
  const inFlight = new Map<string, Promise<SuggestionActionReply>>();
  let active = true;
  ctx.effect(() => () => {
    active = false;
    summaries.clear();
    pages.clear();
    pending.clear();
    inFlight.clear();
  }, 'dsh-bot: follow-up sources');
  const remote = () => {
    const service = ctx.get('remote.dshBot.proactive');
    if (!active || !service) throw new Error('Follow-up service unavailable');
    return service;
  };
  const page = async (request: FollowUpPageRequest) => {
    const value = followUpPageSchema.parse(unwrap(await remote().followUpPage(request)));
    if (value.rows.some(row => subjectKey(row.subject) !== subjectKey(request.subject))) throw new Error('Follow-up page owner mismatch');
    return value;
  };
  const send = async (command: FollowUpCommand): Promise<SuggestionActionReply> => {
    const service = remote();
    if (command.kind === 'policy') return unwrap(await service.followUpPolicy(command.input));
    if (command.kind === 'watch') return unwrap(await service.followUpWatchCreate(command.input));
    return unwrap(await service.followUpAction(command.input));
  };
  return {
    summary(subject) {
      const key = subjectKey(subject);
      let catalog = summaries.get(key);
      if (!catalog) {
        catalog = createPollingCatalog<{ status?: FollowUpStatus }>(ctx, {}, async () => {
          const status = followUpStatusReply.parse(unwrap(await remote().followUpSummary(subject)));
          if (status.state === 'ready') {
            const summary = followUpSummarySchema.parse(status.summary);
            if (subjectKey(summary.policy.subject) !== key || summary.rows.some(row => subjectKey(row.subject) !== key)) {
              throw new Error('Follow-up summary owner mismatch');
            }
            return { status: { ...status, summary } };
          }
          return { status };
        }, options);
        summaries.set(key, catalog);
      }
      return catalog;
    },
    firstPage(subject) {
      const key = subjectKey(subject);
      let catalog = pages.get(key);
      if (!catalog) {
        catalog = createPollingCatalog<{ page?: FollowUpPage }>(ctx, {}, async () => ({ page: await page({ subject }) }), options);
        pages.set(key, catalog);
      }
      return catalog;
    },
    page,
    groupContinuation: {
      async offer(input) { return followUpGroupChoiceReplySchema.parse(unwrap(await remote().followUpGroupChoice(input))); },
      async accept(input) { return followUpGroupReplySchema.parse(unwrap(await remote().followUpGroupAccept(input))); },
      async abandon(input) { return unwrap(await remote().followUpGroupAbandon(input)); },
    },
    openSession(origin, signal) {
      const target = followUpSessionTarget(origin);
      if (!target) throw new Error('Original follow-up task unavailable');
      if (active && !signal.aborted) ctx.uiWorkspace.openSession(target);
    },
    pending: subject => pending.get(subjectKey(subject)),
    async run(command) {
      const key = subjectKey(command.input.subject);
      const current = pending.get(key);
      if (current && current.input.commandId !== command.input.commandId) return { kind: 'unknown', commandId: current.input.commandId };
      const running = inFlight.get(key);
      if (running) return running;
      const retained = current ?? command;
      pending.set(key, retained);
      const sendOnce = send(retained).then(reply => {
        if (active && reply.kind !== 'unknown') pending.delete(key);
        if (active && reply.kind === 'receipt' && retained.kind === 'card' && retained.input.action === 'forget') {
          summaries.get(key)?.reset({});
          pages.get(key)?.reset({});
        }
        return reply;
      }, (): SuggestionActionReply => ({ kind: 'unknown', commandId: retained.input.commandId }))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, sendOnce);
      return sendOnce;
    },
  };
}

const noSubscribe = () => () => {};
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const subscribeVisibility = (listener: () => void) => {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
export const useFollowUpVisibility = () => useSyncExternalStore(subscribeVisibility, visible, visible);
const noSnapshot = () => undefined;
export function useFollowUpPolicyRevision(source: FollowUpSource | undefined, subject: Subject, active: boolean) {
  const enabled = useFollowUpVisibility() && active;
  const catalog = source?.summary(subject);
  const snapshot = useSyncExternalStore(enabled && catalog ? catalog.subscribe : noSubscribe,
    catalog?.getSnapshot ?? noSnapshot, catalog?.getSnapshot ?? noSnapshot);
  const status = snapshot?.status;
  return !snapshot?.error && status?.state === 'ready' && status.summary.policy.localEnabled
    ? status.summary.policy.revision : undefined;
}
export function useFollowUpCatalog<Payload>(catalog: PollingCatalog<Payload>, active: boolean) {
  return useSyncExternalStore(active ? catalog.subscribe : noSubscribe, catalog.getSnapshot, catalog.getSnapshot);
}
