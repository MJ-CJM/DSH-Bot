import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';

export const provider = 'pb00-loopback';
export const route = { provider, model: 'pb00-synthetic', maxTokens: 64 };
export const toolName = 'pb00_approval_probe';
export const reply = 'PB00_SYNTHETIC_REPLY';

export interface ModelCall {
  sessionId: string;
  approvalTool: boolean;
  sequence: number;
}

export class FixtureAdapter extends LlmAdapter {
  constructor(private readonly url: URL, private readonly calls: ModelCall[], private readonly limits: ReadonlyMap<string, number>) {
    super();
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    assert.equal(options.provider, provider);
    assert.equal(options.model, route.model);
    assert.ok(options.sessionId);
    const toolNames = (options.tools ?? []).map(tool => tool.name);
    assert.ok(toolNames.every(name => name === toolName), 'only the fixture approval tool may be exposed');
    const sessionCalls = this.calls.filter(call => call.sessionId === options.sessionId).length;
    const limit = this.limits.get(options.sessionId);
    assert.ok(limit === undefined || sessionCalls < limit, 'PB00 authorized model-request budget exhausted');
    const call: ModelCall = {
      sessionId: options.sessionId,
      approvalTool: toolNames.includes(toolName) && sessionCalls % 2 === 0,
      sequence: this.calls.length + 1,
    };
    this.calls.push(call);
    const response = await fetch(this.url, {
      method: 'POST', body: JSON.stringify(call), redirect: 'error',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), reply);
    if (call.approvalTool) {
      const id = ToolCallId(`pb00-approval-${call.sequence}`);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: toolName, argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: toolName, arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

export async function until<T>(poll: () => Promise<T | undefined> | T | undefined, signal: AbortSignal): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const value = await poll();
    if (value !== undefined) return value;
    await delay(30, undefined, { signal });
  }
}

function readLine(stream: Readable, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = '';
    const cleanup = () => {
      stream.off('data', data);
      stream.off('error', fail);
      stream.off('end', ended);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const ended = () => fail(new Error('Native pipe closed before newline'));
    const aborted = () => fail(signal.reason);
    const data = (chunk: Buffer) => {
      content += chunk.toString();
      const newline = content.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      stream.pause();
      resolve(content.slice(0, newline));
    };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    stream.on('error', fail);
    stream.on('end', ended);
    stream.on('data', data);
    stream.resume();
  });
}

export async function nativeIpc(ctx: Context, path: string, cwd: string, signal: AbortSignal,
  onStart: (handle: SubprocessHandle) => void) {
  const executable = await ctx.subprocess.resolveExecutable(process.execPath);
  assert.ok(executable);
  const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  const handle = ctx.subprocess.spawn({
    argv: [executable, path],
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 2048 }, control: 'pipe' },
    graceMs: 300,
    env: { ...env, LANG: 'C' },
    signal,
  });
  onStart(handle);
  void handle.done.catch(() => {});
  const { stdin, stdout, control } = handle;
  assert.ok(stdin && stdout && control, 'native subprocess raw pipes and control');
  const ready = await readLine(stdout, signal);
  const match = /^ready:(\d+):(.*)$/.exec(ready);
  assert.ok(match?.[1] && match[2]);
  const envKeys = JSON.parse(match[2]) as string[];
  assert.deepEqual(envKeys.filter(key => key !== '__CF_USER_TEXT_ENCODING'), ['LANG']);
  const returned = readLine(stdout, signal);
  const returnedControl = readLine(control, signal);
  stdin.write('stdio-proof\n');
  control.write('control-proof\n');
  assert.deepEqual(await Promise.all([returned, returnedControl]), ['stdio-proof', 'control-proof']);
  return { executable, pid: Number(match[1]), stdio: true, control: true, envKeys };
}
