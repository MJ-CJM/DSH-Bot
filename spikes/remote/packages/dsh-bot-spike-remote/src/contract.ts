/** Single source of wire shape and Host/Client result types. Browser-safe. */
import { z } from 'zod';
import type { TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
export const botRow = z.strictObject({ id: z.string(), name: z.string() });
export const listResult = z.array(botRow);
export type BotRow = z.infer<typeof botRow>;
export type ListResult = z.infer<typeof listResult>;
export type ListMethod = () => Promise<ListResult>;
export const spec = {
  package: 'dsh-bot-spike-remote',
  methods: {
    'dshBot/list': {
      service: 'dshBots', invocation: { kind: 'direct' }, parameters: [],
      result: { mode: 'strict', typeSymbol: 'dsh-bot-spike-remote#ListResult', create: () => listResult },
    },
  },
} satisfies TypertRemoteSpec;
