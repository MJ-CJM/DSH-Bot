import assert from 'node:assert/strict';
import { LlmAdapter, ToolCallId, LlmError } from '@deepseek-ai/dsh-llm';
export const canary = 'DP_B1_SYNTHETIC_CANARY_7d56e3';
export class LoopbackAdapter extends LlmAdapter {
  constructor(endpoint) { super(); this.endpoint = endpoint; this.count = 0; this.mode = 'text'; }
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic fixture' }]; }
  async *stream(options) {
    // Capture the entire native request, including replay/header/toolHistory fields, before serialization loss.
    const response = await fetch(this.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options), signal: options.signal, redirect: 'error',
    });
    assert.equal(response.status, 200);
    this.count++;
    if (this.mode === 'error') { this.mode = 'text'; throw new LlmError('Synthetic retry', 'RATE_LIMIT'); }
    if (this.mode === 'tool') {
      this.mode = 'text';
      const id = ToolCallId(`dp-tool-${this.count}`);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'dp_fixture', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'dp_fixture', arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = this.mode === 'canary' ? canary : 'DP_LOOPBACK_OK';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' },
      ...(this.mode === 'canary' ? { replayState: { response: { syntheticReplay: canary } } } : {}) };
  }
}
