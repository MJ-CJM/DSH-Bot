import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, realpath, rename } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Test-only boundaries around the plugin's own public service. The underlying
// submit always performs its real core transaction; no fake receipt is returned.
export const faultPoints = Object.freeze({
  F08: { command: 'accept-decision', when: 'after', expects: 'pending' },
  F09: { command: 'dispatch-claim', when: 'after', expects: 'claimed' },
  F10: { command: 'dispatch-send', when: 'after', expects: 'sent' },
  F13A: { command: 'report-result', when: 'staged', expects: 'sent' },
  F13B: { command: 'report-result', when: 'acknowledging', expects: 'delivered' },
});

export async function installSubmissionFault({ service, dir, nonce, point, signal, emit = console.log }) {
  assert.ok(faultPoints[point], 'Unknown persisted submission boundary');
  assert.match(nonce, /^[a-f0-9]{32,64}$/);
  const actual = await realpath(dir), isolated = await realpath(resolve('.dsh-dev'));
  assert.ok(actual.startsWith(isolated + sep), 'Fault receipts must remain isolated');
  const stop = new AbortController();
  const active = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const selected = faultPoints[point];
  const method = selected.when === 'staged' ? 'stageResult' : selected.when === 'acknowledging' ? 'acknowledgeResult' : 'submit';
  const original = service[method];
  assert.equal(typeof original, 'function', 'The staged result boundary must be explicitly available');
  let armed = true;
  async function barrier(commandId, body, reply) {
    armed = false;
    const rows = await service.workList();
    const found = rows.find(row => body.assignmentId ? row.assignmentId === body.assignmentId : row.decisionId === body.decisionId);
    assert.ok(found, 'Submission boundary must resolve exact durable work');
    assert.equal(found.state, selected.expects, 'Unexpected persistent work phase');
    const committed = selected.when === 'after' || selected.when === 'acknowledging';
    if (committed) assert.equal(reply?.receipt?.status, 'committed');
    const responsibility = found.responsibility
      ? (await service.responsibilities(found.target.bot)).find(row => row.responsibility.id === found.responsibility.id) : undefined;
    const receipt = {
      point, nonce, pid: process.pid, commandId, command: body.kind, when: selected.when,
      commandDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      committed,
      durableHostResult: selected.when === 'staged',
      resultSubmitted: body.kind === 'report-result',
      ...(reply?.receipt ? { receiptId: reply.receipt.receiptId, committedSeq: reply.receipt.committedSeq } : {}),
      work: { ticketId: found.ticketId, assignmentId: found.assignmentId, decisionId: found.decisionId,
        state: found.state, revision: found.revision, sessionId: found.sessionId, inputId: found.inputId,
        evidenceDigest: found.evidenceDigest },
      at: new Date().toISOString(),
      ...(responsibility ? { responsibility } : {}),
    };
    const temporary = resolve(actual, 'fault-barrier.tmp');
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(receipt, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, resolve(actual, 'fault-barrier.json'));
    emit(`DSH_PROACTIVE_FAULT ${point} ${nonce}`);
    // Control runs release the exact nonce; injected runs are killed externally.
    while (!active.aborted) {
      const release = await readFile(resolve(actual, 'fault-release'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (release.trim() === nonce) return;
      await delay(25, undefined, { signal: active });
    }
    active.throwIfAborted();
  }
  const wrapped = async function(commandId, body, acknowledgement) {
    const matches = armed && body.kind === selected.command &&
      (body.kind !== 'report-result' || body.result?.state === 'delivered');
    if (matches) armed = false;
    if (matches && selected.when === 'before') await barrier(commandId, body);
    if (matches && selected.when === 'acknowledging') await barrier(commandId, body, acknowledgement);
    const reply = await original.call(this, commandId, body, acknowledgement);
    if (matches && (selected.when === 'after' || selected.when === 'staged')) await barrier(commandId, body, reply);
    return reply;
  };
  service[method] = wrapped;
  return () => {
    stop.abort();
    if (service[method] === wrapped) service[method] = original;
  };
}

export async function awaitSubmissionBarrier({ dir, nonce, point, hostPid, timeoutMs = 20000 }) {
  const stop = AbortSignal.timeout(timeoutMs);
  while (!stop.aborted) {
    const text = await readFile(resolve(dir, 'fault-barrier.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (text) {
      // An incomplete write is not a valid barrier; wait for the newline-free
      // JSON document to parse, then validate its exact process and run identity.
      let value;
      try { value = JSON.parse(text); } catch { await delay(25, undefined, { signal: stop }); continue; }
      assert.equal(value.nonce, nonce); assert.equal(value.point, point);
      assert.equal(value.pid, hostPid); assert.equal(value.command, faultPoints[point].command);
      assert.equal(value.work?.state, faultPoints[point].expects);
      return value;
    }
    await delay(25, undefined, { signal: stop });
  }
  stop.throwIfAborted();
}
