import assert from 'node:assert/strict';

/** Match the submitted RPC and exact content, independently of its claimed source kind. */
export function submittedPrompt(events, requestId, content) {
  const matches = events.filter(e => e.type === 'user/message' && e.data.source.rpcId === requestId);
  assert.equal(matches.length, 1, `prompt.rpcId ${requestId}: expected exactly one accepted input`);
  const event = matches[0];
  assert.deepEqual(event.data.content, content, 'prompt.content: must match the submitted input exactly');
  assert.equal(event.data.source.kind, 'user', 'prompt.source: runtime-context is never a direct user input');
  assert.equal(event.data.source.principal, undefined, 'prompt.principal: synthetic owner admission');
  return event;
}

/** Test-only, exact Agent/tool answerer ahead of the Web Remote waterfall bridge. */
export function syntheticApproval(agent, answer) {
  return agent.ctx.effect(() => agent.ctx.on('approval/request', (req, next) => {
    if (req.agent !== agent || req.toolName !== 'bot_memory_confirm') return next();
    return answer(req);
  }, { prepend: true }));
}

export async function bounded(work, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
