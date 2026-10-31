import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { graphRequestSchema, graphResultSchema } from './reference-memory.js';
import { workspaceRequestSchema, workspaceResultSchema } from './workspace.js';
const codec = <S extends z.ZodType>(schema: S) => ({
  mode: 'strict' as const,
  typeSymbol: 'dsh-bot/workspace#Value',
  create: () => schema,
  encode: (v: unknown) => schema.parse(v),
  decode: (v: unknown) => schema.parse(v),
});
const parameter = <S extends z.ZodType>(schema: S) => ({
  name: 'input',
  source: 'json' as const,
  codec: codec(schema),
  strictCodec: codec(schema),
});
export const workspaceSpec = {
  package: 'dsh-bot/workspace',
  methods: {
    'dshBot.workspace/request': {
      service: 'dshBotWorkspaceRemote',
      invocation: { kind: 'direct' },
      parameters: [parameter(workspaceRequestSchema)],
      result: codec(workspaceResultSchema),
    },
    'dshBot.referenceMemory/request': {
      service: 'dshBotReferenceMemoryRemote',
      invocation: { kind: 'direct' },
      parameters: [parameter(graphRequestSchema)],
      result: codec(graphResultSchema),
    },
  },
} as const satisfies TypertRemoteSpec;
export interface WorkspaceMethods {
  request(input: z.input<typeof workspaceRequestSchema>): Promise<RemoteResult<z.output<typeof workspaceResultSchema>>>;
}
export interface ReferenceMemoryMethods {
  request(input: z.input<typeof graphRequestSchema>): Promise<RemoteResult<z.output<typeof graphResultSchema>>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'dshBot.workspace/request': WorkspaceMethods['request'];
    'dshBot.referenceMemory/request': ReferenceMemoryMethods['request'];
  }
  interface TypertRemoteNamespaceMap {
    'dshBot.workspace': WorkspaceMethods;
    'dshBot.referenceMemory': ReferenceMemoryMethods;
  }
}
export const WORKSPACE_REMOTE = createTypertRemoteInfo(workspaceSpec, z);
