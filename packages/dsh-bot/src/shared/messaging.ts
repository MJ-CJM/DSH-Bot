import { z } from 'zod';
import { botKeySchema } from './identity.js';
import { botIdSchema } from './ids.js';
import { avatarVariantSchema, avatarColorSchema } from './schema.js';
const id = z.string().min(1).max(512);
const time = z.number().int().nonnegative();
const positive = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const messageInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('list'),
    cursor: id.optional(),
    limit: positive.max(200).default(50),
  }),
  z.strictObject({
    action: z.literal('send'),
    to: botIdSchema,
    content: z.string().trim().min(1),
    mode: z.enum(['notify', 'ask']),
    priority: z.enum(['normal', 'interrupt']).default('normal'),
    inReplyToContext: id.optional(),
  }),
  z.strictObject({
    action: z.literal('reply'),
    replyTo: id,
    content: z.string().trim().min(1),
  }),
]);
export type MessageInput = z.output<typeof messageInputSchema>;
const display = z.strictObject({
  name: z.string(),
  avatarVariant: avatarVariantSchema.optional(),
  avatarColor: avatarColorSchema.optional(),
});
export const envelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id,
    from: botKeySchema,
    to: botKeySchema,
    fromSessionId: id,
    toSessionId: id,
    threadId: id,
    correlationId: id,
    parentMessageId: id.optional(),
    replyTo: id.optional(),
    origin: z.strictObject({
      bot: botKeySchema,
      sessionId: id,
      userMessageId: id,
    }),
    hop: positive,
    depth: positive,
    mode: z.enum(['notify', 'ask', 'reply']),
    priority: z.enum(['normal', 'interrupt']),
    ts: time,
    expiresAt: time,
    path: z.array(botKeySchema).min(2),
    content: z.string().min(1).optional(),
    contentDigest: digest,
    fromDisplay: display,
    toDisplay: display,
    authorizationId: id,
  authorizedTargets: z.array(botKeySchema).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.expiresAt <= e.ts) ctx.addIssue({ code: 'custom', message: 'Invalid expiry' });
    if ((e.mode === 'reply') !== Boolean(e.replyTo))
      ctx.addIssue({
        code: 'custom',
        message: 'replyTo required only for reply',
      });
    if (e.mode === 'reply' && e.priority !== 'normal')
      ctx.addIssue({ code: 'custom', message: 'Replies cannot interrupt' });
    if (e.from.botId === e.to.botId && e.from.botCreatedAt === e.to.botCreatedAt)
      ctx.addIssue({ code: 'custom', message: 'Self route' });
  });
export type MessageEnvelope = z.output<typeof envelopeSchema>;
export const messageSourceSchema = z.strictObject({
  kind: z.enum(['dsh-bot-message', 'dsh-bot-message-sent']),
  form: z.enum(['relay', 'notice']),
  summary: z.string().optional(),
  messageId: id,
  threadId: id,
  replyTo: id.optional(),
  from: botKeySchema,
  to: botKeySchema,
  fromSessionId: id,
  toSessionId: id,
  hop: positive,
  mode: z.enum(['notify', 'ask', 'reply']),
  priority: z.enum(['normal', 'interrupt']),
  displaySnapshots: z.strictObject({ from: display, to: display }),
}).refine((s) => (s.kind === 'dsh-bot-message' ? s.form === 'relay' : s.form === 'notice') &&
  (s.mode === 'reply' ? Boolean(s.replyTo) && s.priority === 'normal' : !s.replyTo), 'Invalid producer form or reply');
export const wakeSourceSchema = z.strictObject({
  kind: z.literal('dsh-bot-message-wake'),
  form: z.literal('notice'),
  summary: z.string(),
  messageId: id,
  generation: id,
  toSessionId: id,
});
export type MessageSource = z.output<typeof messageSourceSchema>;
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bot-message': MessageSource & { kind: 'dsh-bot-message' };
    'dsh-bot-message-sent': MessageSource & { kind: 'dsh-bot-message-sent' };
    'dsh-bot-message-wake': z.output<typeof wakeSourceSchema>;
  }
}
// Validate actual factory output, including source and text; no z.custom permissive persistence boundary.
export const nativeMessageSchema = z.strictObject({
  id,
  role: z.literal('user'),
  source: messageSourceSchema,
  content: z.array(z.strictObject({ type: z.literal('text'), text: z.string() })).min(1),
});
const nativeRef = z.strictObject({
  sessionId: id,
  messageId: id,
  seq: time.optional(),
  turn: time.optional(),
});
export const messageRecordSchema = z
  .strictObject({
    envelope: envelopeSchema,
    nativeInput: nativeMessageSchema.optional(),
    outgoingInput: nativeMessageSchema.optional(),
    flowId: z.uuid().optional(),
    invocationKey: id,
    invocationDigest: digest,
    revision: positive,
    delivery: z.enum(['queued', 'delivering', 'delivered', 'unknown', 'canceled', 'expired', 'failed']),
    processing: z.enum(['pending', 'claimed', 'completed', 'interrupted', 'unknown']),
    response: z.enum(['not-required', 'waiting', 'reply-queued', 'replied', 'timed-out']),
    nativeRef: nativeRef.optional(),
    outgoingRef: nativeRef.optional(),
    lastErrorCode: id.optional(),
    nextAttemptAt: time.optional(),
    claimedTurn: time.optional(),
    interrupt: z.enum(['requested', 'issued', 'pending', 'stopped', 'unknown', 'disabled']).optional(),
    retainedAt: time.optional(),
    retryCount: time.default(0),
    interruptTurn: time.optional(),
    interruptDeadlineAt: time.optional(),
  })
  .superRefine((r, ctx) => {
    const e = r.envelope;
    for (const [name, m, kind, form] of [
      ['nativeInput', r.nativeInput, 'dsh-bot-message', 'relay'],
      ['outgoingInput', r.outgoingInput, 'dsh-bot-message-sent', 'notice'],
    ] as const) {
      if (!m) continue;
      const s = m.source;
      const matches =
        s.kind === kind &&
        s.form === form &&
        s.messageId === e.id &&
        s.threadId === e.threadId &&
        s.replyTo === e.replyTo &&
        s.hop === e.hop &&
        s.mode === e.mode &&
        s.priority === e.priority &&
        s.fromSessionId === e.fromSessionId &&
        s.toSessionId === e.toSessionId &&
        JSON.stringify(s.from) === JSON.stringify(e.from) &&
        JSON.stringify(s.to) === JSON.stringify(e.to) &&
        JSON.stringify(s.displaySnapshots) === JSON.stringify({ from: e.fromDisplay, to: e.toDisplay });
      if (!matches)
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'Native source differs from envelope',
        });
    }
    if (r.nativeInput && r.nativeInput.id === r.outgoingInput?.id)
      ctx.addIssue({
        code: 'custom',
        message: 'Incoming and outgoing identities must differ',
      });
  });
export type MessageRecord = z.output<typeof messageRecordSchema>;
export const threadSchema = z.strictObject({
  id,
  rootId: id,
  authorizationId: id,
  count: time,
  openAsks: z.array(id),
  deadline: time,
  closed: z.boolean(),
  revision: positive,
});
export const reservationSchema = z.strictObject({
  id,
  invocationKey: id,
  invocationDigest: digest,
  pair: id,
  target: id,
  threadId: id,
  mode: z.enum(['notify', 'ask', 'reply']),
  priority: z.enum(['normal', 'interrupt']),
  at: time,
  nextAttemptAt: time.optional(),
});
export const dedupeSchema = z.strictObject({
  id,
  invocationKey: id,
  invocationDigest: digest,
  messageId: id,
  at: time,
  nativeRef: nativeRef.optional(),
  outgoingRef: nativeRef.optional(),
});
export const readStateSchema = z.strictObject({
  id,
  sessionId: id,
  throughSeq: time,
  revision: positive,
});
export const messageReceiptSchema = z.strictObject({
  messageId: id,
  threadId: id,
  status: z.literal('queued'),
  mode: z.enum(['notify', 'ask', 'reply']),
});
export type MessageReceipt = z.output<typeof messageReceiptSchema>;
// Both faces use these strict codecs. No remote endpoint is exposed before B04/B05.
export const messagingCodecs = {
  input: {
    encode: (value: unknown) => messageInputSchema.parse(value),
    decode: (value: unknown) => messageInputSchema.parse(value),
  },
  receipt: {
    encode: (value: unknown) => messageReceiptSchema.parse(value),
    decode: (value: unknown) => messageReceiptSchema.parse(value),
  },
};
