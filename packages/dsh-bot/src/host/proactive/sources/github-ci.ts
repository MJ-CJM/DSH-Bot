import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ciPageSchema, type CiScope } from './ci.js';
import { digest } from '../wire.js';
import type { ProactiveService } from '../service.js';

export const githubCiSchema = z.strictObject({
  credentialRef: z.string().trim().min(1).max(512),
  since: z.iso.datetime(),
  maxRuns: z.number().int().min(1).max(1000).default(256),
  timeoutMs: z.number().int().min(1000).max(60000).default(15000),
});
export type GithubCi = z.output<typeof githubCiSchema>;
const runSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  run_attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workflow_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  head_branch: z.string(), head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.string(), conclusion: z.string().nullable(),
  updated_at: z.iso.datetime(), created_at: z.iso.datetime(),
  repository: z.object({ full_name: z.string() }),
});
const responseSchema = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(runSchema).max(32) });
type Service = Pick<ProactiveService, 'ciCheckpoint' | 'observeCi'>;

async function boundedJson(response: Response) {
  if (!response.ok || !response.body) throw new Error('CI provider unavailable');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('CI response too large');
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

/** A bounded complete sweep precedes ingestion. Only fixed GitHub GET endpoints
 * are reachable; native Credentials is resolved again before each request/commit.
 * No log, PR body, executable text or credential enters the task core. */
export async function observeGithubCi(scope: CiScope, config: GithubCi, service: Service,
  signal: AbortSignal, credential: () => Promise<string | undefined>, request: typeof fetch = fetch) {
  const initial = await service.ciCheckpoint(scope);
  const assertSource = async () => {
    signal.throwIfAborted();
    const current = await service.ciCheckpoint(scope);
    if (current && (current.generation > scope.generation || (current.generation === scope.generation && current.revoked))) throw new Error('CI source revoked');
    return current?.generation === scope.generation ? current.checkpoint : null;
  };
  const secret = await credential();
  if (!secret) throw new Error('CI credential unavailable');
  const check = async () => {
    await assertSource();
    if (await credential() !== secret) throw new Error('CI credential changed');
    signal.throwIfAborted();
  };

  type Window = { from: number; through: number };
  type Position = { fresh: number; history: number; historyEnd: number };
  type Lane = "fresh" | "history";
  const iso = (second: number) => new Date(second * 1000).toISOString().replace('.000Z', 'Z');
  const since = Date.parse(config.since), start = Math.floor(since / 1000);
  let checkpoint = initial?.generation === scope.generation ? initial.checkpoint : null;
  async function fetchPage(page: number, window?: Window) {
    await check();
    const url = new URL(`https://api.github.com/repos/${scope.repository}/actions/runs`);
    url.searchParams.set('branch', scope.branch);
    url.searchParams.set('created', window ? `${iso(window.from)}..${iso(window.through)}` : `>=${config.since}`);
    url.searchParams.set('per_page', '32'); url.searchParams.set('page', String(page));
    const response = await request(url, { method: 'GET', redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${secret}`, 'X-GitHub-Api-Version': '2026-03-10' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    });
    return responseSchema.parse(await boundedJson(response));
  }
  async function collect(first: z.output<typeof responseSchema>, window?: Window) {
    const runs = new Map<number, z.output<typeof runSchema>>();
    for (let page = 1; ; page++) {
      const body = page === 1 ? first : await fetchPage(page, window);
      if (body.total_count !== first.total_count) throw new Error('CI sweep changed during pagination');
      for (const run of body.workflow_runs) {
        const at = Date.parse(run.created_at);
        if (run.repository.full_name.toLowerCase() !== scope.repository.toLowerCase() || run.head_branch !== scope.branch ||
          (window ? at < window.from * 1000 || at >= (window.through + 1) * 1000 : at < since) || runs.has(run.id))
          throw new Error('CI sweep scope or pagination changed');
        runs.set(run.id, run);
      }
      if (runs.size === first.total_count) break;
      if (body.workflow_runs.length !== 32 || page >= Math.ceil(first.total_count / 32)) throw new Error('CI sweep incomplete');
    }
    return [...runs.values()].filter(run => Date.parse(run.created_at) >= since && run.status === 'completed' &&
      ['failure','success','cancelled','timed_out','action_required','startup_failure','stale'].includes(run.conclusion ?? '')).map(run => ({
      repository: scope.repository, branch: scope.branch, runId: String(run.id),
      job: `workflow-${run.workflow_id}`, commit: run.head_sha, observedAt: run.updated_at, attempt: run.run_attempt,
      conclusion: run.conclusion === 'success' ? 'success' as const : run.conclusion === 'cancelled' ? 'cancelled' as const : 'failure' as const,
    })).sort((a,b) => a.observedAt.localeCompare(b.observedAt) || a.runId.localeCompare(b.runId));
  }

  const positionKey = (position: Position) => `github2:${since}:${position.fresh}:${position.history}:${position.historyEnd}`;
  async function commit(rows: Awaited<ReturnType<typeof collect>>, position?: Position, next?: Position, lane?: Lane) {
    const sweep = digest([scope, config.since, rows]);
    const prefix = position ? positionKey(position) : 'github';
    const end = `${next ? positionKey(next) : prefix}:${sweep}:done`;
    if (checkpoint === end) return;
    const progress = `${prefix}:${sweep}:${lane ? lane + ':' : ''}`;
    const offsetText = checkpoint?.startsWith(progress) ? checkpoint.slice(progress.length) : '';
    const resume = /^\d+$/u.test(offsetText) ? Number(offsetText) : 0;
    const startAt = Number.isSafeInteger(resume) && resume % 32 === 0 && resume < rows.length ? resume : 0;
    for (let offset = startAt; offset < Math.max(rows.length, 1); offset += 32) {
      await check();
      const after = offset + 32 >= rows.length ? end : `${progress}${offset + 32}`;
      if (checkpoint === after) continue;
      const page = ciPageSchema.parse({ complete: true, before: checkpoint, after, rows: rows.slice(offset, offset + 32) });
      const result = await service.observeCi(randomUUID(), scope, page);
      if (result.kind !== 'receipt' || !result.receipt || !['committed', 'duplicate'].includes(result.receipt.status))
        throw new Error('CI page not committed');
      checkpoint = after;
    }
  }

  const saved = /^github2:(-?\d+):(-?\d+):(-?\d+):(-?\d+):[a-f0-9]{64}:(?:done|(fresh|history):\d+)$/u.exec(checkpoint ?? '');
  let position: Position = { fresh: start, history: start, historyEnd: start };
  if (saved && Number(saved[1]) === since && Number.isSafeInteger(Number(saved[2])) && Number.isSafeInteger(Number(saved[3])) &&
      Number.isSafeInteger(Number(saved[4])) && start <= Number(saved[3]) && Number(saved[3]) <= Number(saved[4]) && Number(saved[4]) <= Number(saved[2])) {
    position = { fresh: Number(saved[2]), history: Number(saved[3]), historyEnd: Number(saved[4]) };
  } else {
    // Existing opaque cursors remain valid as the expected commit cursor. Re-reading old
    // observations is safe because the coordinator deduplicates by run revision.
    const first = await fetchPage(1);
    if (first.total_count <= config.maxRuns) {
      await commit(await collect(first));
      return;
    }
  }

  async function advance(from: number, through: number, lane: Lane) {
    if (from > through) return;
    // GitHub supports second-resolution created ranges. Bisect until a window fits,
    // and use the provider's 1,000-result cap for an indivisible, very busy second.
    let window = { from, through };
    let first = await fetchPage(1, window);
    while (first.total_count > config.maxRuns && window.from < window.through) {
      window = { from, through: from + Math.floor((window.through - from) / 2) };
      first = await fetchPage(1, window);
    }
    if (first.total_count > 1000) throw new Error('CI source exceeds GitHub pagination in one second');
    const rows = await collect(first, window);
    const next = { ...position, [lane]: window.through + 1 };
    if (lane === 'history' && window.through === through) {
      next.history = start;
      next.historyEnd = position.fresh;
    } else if (lane === 'fresh' && position.historyEnd === start) {
      next.historyEnd = next.fresh;
    }
    await commit(rows, position, next, lane);
    position = next;
  }

  // Each poll catches up new runs and revisits one previously completed window.
  // Old reruns and jobs that finished late are thus discovered without a permanent
  // list of every outstanding ID. A crash mid-window replays durable native revisions.
  const history = () => advance(position.history, position.historyEnd - 1, 'history');
  const fresh = () => advance(position.fresh, Math.floor(Date.now() / 1000) - 1, 'fresh');
  // Finish a partially committed historical page before advancing the new-run frontier.
  if (saved?.[5] === 'history') { await history(); await fresh(); }
  else {
    const hadHistory = position.history < position.historyEnd;
    await fresh();
    if (hadHistory) await history();
  }
}
