import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Engine, Candidate, EngineOptions, OutboundMessage, Outbox, Outcome, Policy, Repositories, Trigger,
} from '../../vendor/superagent/src/core/index.ts'

export const time = '2026-11-07T00:00:00.000Z'

export function event(id: string, thread = 'ticket', fields: Partial<Trigger> = {}): Trigger {
  return {
    id, at: time, source: 'fixture', actor: { source: 'fixture', id: 'person' }, human: true,
    threads: [{ source: 'fixture', id: thread }], text: `message ${id}`,
    channel: { source: 'fixture', thread, address: { id } }, meta: {},
    ...fields,
  }
}

export const accept = { kind: 'accept', title: 'Fixture task', scope: 'fixture only', reason: 'fixture request', acknowledgement: 'queued' } as const

export const policy: Policy = {
  version: 'fixture-1', paused: false, evalTimeoutMs: 60_000,
  gate: trigger => trigger.human
    ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
    : { admissible: false, reason: 'fixture excludes machine events' },
  revalidate: () => true,
  admitsInferred: rules => rules.length > 0,
}

export function engineOptions(repo: Repositories): EngineOptions {
  return {
    repo, policy: () => policy, now: () => time, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: () => {} }, executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: () => {}, withdraw: () => {}, status: () => undefined },
  }
}

export function decide(engine: Engine, candidate: Candidate, outcome: Outcome) {
  const origin = candidate.triggers[0]
  assert(origin, 'Expected a candidate origin trigger')
  return engine.decide(origin.id, { ...outcome, evalId: candidate.evalId })
}

export interface StoreFixture extends Repositories {
  db: DatabaseSync
  close(): void
  afterCommit(action: () => void): void
  receipts: { get(id: string): (OutboundMessage & { status: string }) | undefined }
}

type FixtureEffects = {
  enqueue(kind: 'launch', key: string, payload: { ticketId: string; assignmentId: string }): void
  handle(kind: 'launch', run: (payload: { ticketId: string; assignmentId: string }, key: string) => Promise<void>): void
  idle(): Promise<void>
  start(): void
  drain(): Promise<void>
}

export interface Coordinator {
  Store: new (path: string, report?: (error: unknown) => void) => StoreFixture
  Effects: new (store: StoreFixture, board: { claim: () => { set: () => void } }) => FixtureEffects
  DurableOutbox: new (host: {
    store: StoreFixture
    effects: FixtureEffects
    sources: { instance: () => { enabled: boolean }; channelAllowed: () => boolean; send: (message: OutboundMessage) => Promise<'sent'> }
    commands: object
    paused(): boolean
  }) => Outbox
  Engine: typeof Engine
  SCHEMA_VERSION: number
}

export function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)
}

export function sqliteState(db: DatabaseSync) {
  return {
    kv: count(db, 'kv'),
    trigger: count(db, 'trigger'),
    trigger_thread: count(db, 'trigger_thread'),
    thread: count(db, 'thread'),
    disposition: count(db, 'disposition'),
    decision: count(db, 'decision'),
    ticket: count(db, 'ticket'),
    effect: count(db, 'effect'),
    outbox: count(db, 'outbox'),
  }
}

export function sqliteError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) }
  const detail = error as Error & { code?: string; errcode?: number; errstr?: string }
  return { message: detail.message, code: detail.code, errcode: detail.errcode, errstr: detail.errstr }
}
