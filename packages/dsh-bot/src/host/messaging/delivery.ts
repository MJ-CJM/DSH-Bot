import { interrupt } from './interrupt.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';
import type {
  MessageRecord,
} from '../../shared/messaging.js';
import { digest, OperationError, } from '../common/operations.js';
import { messageEvidence } from './evidence.js';
import { MessagingRecovery } from './recovery.js';
export class MessagingDelivery extends MessagingRecovery {
  protected async mirror(r: MessageRecord) {
    if (r.outgoingRef) return;
    const source = await this.resolve(r.envelope.fromSessionId);
    await this.exact(source);
    const events = await this.logs(source),
      existing = events.find((e) => e.type === 'user/message' && e.data.id === r.outgoingInput?.id);
    if (
      existing?.type === 'user/message' &&
      r.outgoingInput &&
      digest(existing.data) !== digest(r.outgoingInput)
    )
      throw new OperationError('conflict');
    let seq = existing?.seq;
    if (seq === undefined) {
      if (!r.outgoingInput) throw new OperationError('recovery-needed');
      seq = source.session.append('user/message', r.outgoingInput as unknown as UserMessage, {
        surfaceOp: 'append',
      }).seq;
    }
    if (!(await this.ctx.sessions.flush(source.session))) throw new OperationError('recovery-needed');
    await this.store.update(r.envelope.id, {
      outgoingRef: {
        sessionId: source.session.id,
        messageId: r.outgoingInput?.id ?? (existing?.type === 'user/message' ? existing.data.id : ''),
        seq: Number(seq),
      },
    });
  }
  protected async deliver(id: string, recovery: boolean) {
    if (this.stopped) return;
    let r = this.store.get(id);
    if (!r) return;
    if (['failed', 'expired', 'canceled'].includes(r.delivery)) return;
    const at = this.now();
    if (r.delivery === 'queued' && r.envelope.expiresAt <= at) {
      await this.store.update(id, {
        delivery: 'expired',
        lastErrorCode: 'expired',
      });
      return;
    }
    if (r.nextAttemptAt && r.nextAttemptAt > at) {
      this.arm(id, r.nextAttemptAt - at);
      return;
    }
    try {
      await this.bot(r.envelope.from);
      await this.bot(r.envelope.to);
      if (
        (await this.registry.mainSessions?.find(r.envelope.from.botId))?.sessionId !==
          r.envelope.fromSessionId ||
        (await this.registry.mainSessions?.find(r.envelope.to.botId))?.sessionId !== r.envelope.toSessionId
      )
        throw new OperationError('conflict');
    } catch {
      await this.store.update(id, {
        delivery: r.delivery === 'delivered' ? 'delivered' : 'failed',
        processing: 'unknown',
        lastErrorCode: 'route-gone',
      });
      return;
    }
    let agent: Agent;
    try {
      agent = await this.resolve(r.envelope.toSessionId);
      await this.exact(agent);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'resolve-unavailable';
      if (r.delivery !== 'queued') {
        await this.store.update(id, {
          delivery: r.delivery === 'delivered' ? 'delivered' : 'unknown',
          processing: 'unknown',
          lastErrorCode: code,
        });
        return;
      }
      if (code === 'session/not-found' || code === 'session/writer-held') {
        await this.store.update(id, {
          delivery: 'failed',
          lastErrorCode: code,
        });
        return;
      }
      const retryCount = r.retryCount + 1;
      if (retryCount >= this.store.config.messageRetryAttempts) {
        await this.store.update(id, {
          delivery: 'failed',
          retryCount,
          lastErrorCode: code,
        });
        return;
      }
      const delays = this.store.config.messageRetryDelaysMs,
        delay = delays[Math.min(retryCount - 1, delays.length - 1)] ?? 300000;
      await this.store.update(id, {
        retryCount,
        nextAttemptAt: this.now() + delay,
        lastErrorCode: code,
      });
      this.arm(id, delay);
      return;
    }
    let events = await this.logs(agent),
      evidence = messageEvidence(r, events);
    if (evidence.canceled) {
      await this.store.update(id, {
        delivery: 'canceled',
        processing: 'interrupted',
        lastErrorCode: 'native-canceled',
      });
      return;
    }
    if (evidence.pending && r.envelope.expiresAt <= at) {
      const nativeId = r.nativeInput?.id ?? r.nativeRef?.messageId;
      if (!nativeId || !agent.inbox.remove(MessageId(nativeId))) throw new OperationError('recovery-needed');
      if (!(await this.ctx.sessions.flush(agent.session))) throw new OperationError('recovery-needed');
      await this.store.update(id, {
        delivery: 'expired',
        processing: 'interrupted',
        lastErrorCode: 'expired',
      });
      return;
    }
    if (evidence.seq !== undefined || evidence.pending) {
      await this.store.update(id, {
        delivery: 'delivered',
        processing: evidence.crashClosed ? 'unknown' : evidence.ended
          ? evidence.interrupted
            ? 'interrupted'
            : 'completed'
          : evidence.seq !== undefined
            ? recovery ? 'unknown' : 'claimed'
            : 'pending',
        ...(evidence.turn !== undefined ? { claimedTurn: evidence.turn } : {}),
        nativeRef: {
          sessionId: agent.session.id,
          messageId: r.nativeInput?.id ?? r.nativeRef?.messageId ?? '',
          ...(evidence.seq !== undefined ? { seq: evidence.seq } : {}),
          ...(evidence.turn !== undefined ? { turn: evidence.turn } : {}),
        },
      });
      if (evidence.pending && recovery && agent.status === 'idle') await this.wake(agent, r);
    } else if (evidence.claimed || r.delivery !== 'queued') {
      await this.store.update(id, {
        delivery: r.delivery === 'delivered' ? 'delivered' : 'unknown',
        processing: 'unknown',
        lastErrorCode: 'claimed-unconfirmed',
        ...(r.interrupt === 'issued' ? { interrupt: 'unknown' as const } : {}),
      });
      return;
    } else {
      if (!r.nativeInput) throw new OperationError('recovery-needed');
      await this.store.update(id, { delivery: 'delivering' });
      if (this.stopped) return;
      if (r.envelope.priority === 'interrupt' && this.capabilities.interrupt) {
        await interrupt(this.store, agent, id, this.now);
      }
      agent.followup(r.nativeInput as unknown as UserMessage);
      if (!(await this.ctx.sessions.flush(agent.session))) throw new OperationError('recovery-needed');
      await this.store.update(id, {
        delivery: 'delivered',
        nativeRef: { sessionId: agent.session.id, messageId: r.nativeInput.id },
      });
      events = await this.logs(agent);
      evidence = messageEvidence(r, events);
    }
    r = this.store.get(id);
    if (!r) return;
    if (r.interrupt === 'pending' || r.interrupt === 'issued') {
      const ended =
        r.interruptTurn !== undefined &&
        events.some((e) => e.type === 'turn/end' && e.data.turn === r?.interruptTurn);
      if (ended) await this.store.update(id, { interrupt: 'stopped' });
      else if (r.interruptDeadlineAt && at >= r.interruptDeadlineAt)
        await this.store.update(id, {
          interrupt: 'pending',
          lastErrorCode: 'interrupt-pending',
        });
      else if (r.interruptDeadlineAt) this.arm(id, r.interruptDeadlineAt - at);
    }
    try {
      await this.mirror(r);
    } catch {
      await this.store.update(id, {
        lastErrorCode: 'outgoing-recovery-needed',
      });
    }
    if (r.envelope.replyTo) {
      const ask = this.store.get(r.envelope.replyTo);
      if (ask) await this.store.update(ask.envelope.id, { response: 'replied' });
    }
    if (r.response === 'waiting' && at >= r.envelope.ts + this.store.config.messageAskTimeoutMs)
      await this.store.update(id, { response: 'timed-out' });
    else if (r.response === 'waiting')
      this.arm(id, r.envelope.ts + this.store.config.messageAskTimeoutMs - at);
    await this.store.compact();
  }

}
