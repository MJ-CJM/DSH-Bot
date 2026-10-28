import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';

/** Check isolation before adding our own route, which listProviders() also counts. */
export function registerIsolatedAdapter(llm, adapter) {
  assert.deepEqual(llm.listProviders(), [], 'B6b requires zero pre-existing provider routes');
  return llm.registerAdapter(['dp-b6b'], adapter);
}
export class B6bAdapter extends LlmAdapter {
  plans = new Map(); requests = 0;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic B6b (no provider)' }]; }
  async *stream(options) {
    this.requests++;
    const planned = this.plans.get(options.sessionId)?.shift();
    const tool = typeof planned === 'function' ? planned(options) : planned;
    if (tool) {
      const id = ToolCallId(`b6b-${this.requests}`), args = JSON.stringify(tool.arguments);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: tool.name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool.name, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    const text = 'B6B_SYNTHETIC_RESULT';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
