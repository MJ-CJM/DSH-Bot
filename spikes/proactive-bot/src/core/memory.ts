import assert from 'node:assert/strict'
import { Engine, MemoryRepositories, UserError, type Candidate, type OutboundMessage } from '../../vendor/superagent/src/core/index.ts'
import { accept, decide, engineOptions, event } from './fixtures.ts'

export function replayMemory() {
  const repo = new MemoryRepositories()
  const candidates: Candidate[] = []
  const released: string[] = []
  const starts: string[] = []
  const deliveries: string[] = []
  const stops: string[] = []
  const outbox: OutboundMessage[] = []
  const engine = new Engine({
    ...engineOptions(repo),
    assessor: { request: candidate => candidates.push(candidate), release: evalId => released.push(evalId) },
    executor: {
      start: (ticket, assignment) => starts.push(`${ticket.id}:${assignment.id}`),
      deliver: ticket => deliveries.push(ticket.id),
      stop: ticket => stops.push(ticket.id),
    },
    outbox: { send: message => outbox.push(message), withdraw: () => {}, status: () => undefined },
  })
  const main = event('initial', 'ticket', { threads: [{ source: 'fixture', id: 'ticket' }, { source: 'fixture', id: 'related' }] })
  const first = engine.receive(main)
  const duplicate = engine.receive({ ...main, text: 'duplicate ID with a different payload' })
  assert.equal(first, 'stored')
  assert.equal(duplicate, 'duplicate')
  assert.equal(repo.triggers.get(main.id)?.text, main.text)
  engine.evaluateDue()
  // Two arrivals are queued while the first Eval stays in flight.
  engine.receive(event('second'))
  engine.receive(event('third'))
  engine.evaluateDue()
  const pending = repo.threads.get('fixture:ticket')?.pending
  assert.deepEqual(pending, ['second', 'third'])
  assert.equal(candidates.length, 1)
  assert.deepEqual(repo.threads.get('fixture:related')?.correlated, ['fixture:ticket'])
  const initial = candidates[0]
  assert(initial, 'Expected the initial candidate')
  const ignored = decide(engine, initial, { kind: 'ignore', reason: 'first candidate ignored' })
  engine.evaluateDue()
  assert.equal(candidates.length, 2)
  const batched = candidates[1]
  assert(batched, 'Expected the candidate for queued triggers')
  assert.deepEqual(batched.triggers.map(trigger => trigger.id), ['second', 'third'])
  const accepted = decide(engine, batched, accept)
  const ticketId = accepted.ticketId
  assert(ticketId, 'Expected an accepted ticket ID')
  const assignmentId = repo.tickets.get(ticketId)?.assignments[0]?.id
  assert(assignmentId, 'Expected the first assignment')
  assert.equal(engine.decide('second', accept).id, accepted.id)
  assert.equal(starts.length, 1)
  assert.equal(outbox.length, 1)
  engine.assignmentStarted(ticketId, assignmentId)
  engine.receive(event('followup'))
  const positiveFollowup = [...repo.triggers.disposition('followup')?.fanout ?? []]
  assert.deepEqual(positiveFollowup, [ticketId])
  assert(repo.tickets.get(ticketId)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === 'followup'))
  assert(deliveries.includes(ticketId))
  assert.throws(() => engine.decide('followup', accept), (error: unknown) => error instanceof UserError && error.code === 'workerDecides')
  engine.receive(event('unrelated', 'unrelated'))
  assert.deepEqual(repo.triggers.disposition('unrelated')?.fanout, [])
  engine.evaluateDue()
  const unrelated = candidates[2]
  assert(unrelated, 'Expected the candidate on the unrelated thread')
  assert.deepEqual(unrelated.triggers.map(trigger => trigger.id), ['unrelated'])
  const unavailable = decide(engine, unrelated, { kind: 'unavailable', reason: 'fixture assessor unavailable' })
  const stopped = engine.decide('followup', { kind: 'stop', ticketId, reason: 'fixture human stop' })
  assert.equal(stopped.kind, 'stop')
  assert.equal(repo.tickets.get(ticketId)?.ended?.by, 'human')
  assert.deepEqual(stops, [ticketId])
  engine.receive(event('after-stop'))
  assert.deepEqual(repo.triggers.disposition('after-stop')?.fanout, [])
  assert.deepEqual([ignored.kind, accepted.kind, unavailable.kind, stopped.kind], ['ignore', 'accept', 'unavailable', 'stop'])
  assert.equal(released.length, 3)
  return {
    first, duplicate, alteredPayloadKeepsOriginal: true, pending, requests: candidates.map(candidate => candidate.triggers.map(trigger => trigger.id)),
    correlated: repo.threads.get('fixture:related')?.correlated, positiveFollowup,
    negativeFollowup: repo.triggers.disposition('unrelated')?.fanout, afterStop: repo.triggers.disposition('after-stop')?.fanout,
    decisions: [ignored, accepted, unavailable, stopped].map(decision => ({ id: decision.id, kind: decision.kind, ticketId: decision.ticketId })),
    starts, deliveries, stops, replies: outbox.map(message => message.id), released,
  }
}
