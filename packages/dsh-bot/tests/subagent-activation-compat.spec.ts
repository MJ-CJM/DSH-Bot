import { describe, expect, it } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentActivationSpec } from '@deepseek-ai/dsh-subagent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { compatibleActivationSpec } from '../src/host/common/subagent-activation.js';

describe('native subagent activation public task layout compatibility', () => {
  it('supplies one exact task to the 0.2.1 request and 0.2.2 flat layouts without changing authority', () => {
    const parent = { id: SessionId('checked-parent') } as Agent;
    const signal = new AbortController().signal;
    const request: SubagentActivationSpec['request'] = {
      parent, agentPreset: 'bot-reviewed-member', agentOptions: { provider: 'review', model: 'checked-model' },
      prompt: [{ type: 'text', text: 'exact admitted group content' }], maxDepth: 2,
    };
    const spec: SubagentActivationSpec = { childId: SessionId('reserved-child'), provider: 'spawn',
      delivery: 'caller', label: 'Checked member', signal, request };
    const input = compatibleActivationSpec(spec);
    expect(input.request).toBe(request);
    for (const key of Object.keys(request) as (keyof typeof request)[]) expect(input[key]).toBe(request[key]);
    expect(input.parent).toBe(parent);
    expect(input.prompt).toBe(request.prompt);
    expect(input.agentOptions).toBe(request.agentOptions);
    expect(input.signal).toBe(signal);
    expect(input.childId).toBe(spec.childId);
    expect(input.delivery).toBe('caller');
    expect(spec).not.toHaveProperty('parent');
    expect(request).not.toHaveProperty('signal');
  });
});
