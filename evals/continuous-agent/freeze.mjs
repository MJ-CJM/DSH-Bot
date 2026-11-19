// Explicit, one-time corpus freeze. Never called by ordinary tests or a worker.
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./data/', import.meta.url));
try { await access(`${root}manifest.json`); throw new Error('Already frozen; create a new experiment instead'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
await mkdir(root, { recursive: true });
const hash = x => createHash('sha256').update(x).digest('hex'), manifest = [];
for (const split of ['development', 'validation', 'final']) {
  await mkdir(`${root}${split}`, { recursive: true });
  for (let category = 0; category < 8; category++) {
    const id = `${split}-${category + 1}`, name = `project-${randomBytes(6).toString('hex')}`;
    const value = `value-${randomBytes(6).toString('hex')}`, old = `old-${randomBytes(6).toString('hex')}`;
    const source = (n, at, text, extra = {}) => ({ id: `${id}-e${n}`, at, text, readers: ['owner'], ...extra });
    const scenarios = [
      { sources: [source(1, 1, `Remember: ${name} prefers ${value}.`), source(2, 2, `Only for today's demo, use ${old}.`)], question: `What is ${name}'s long-term preference?`, required: [value], forbidden: [old], action: 'answer' },
      { sources: [source(1, 1, `Remember: ${name}'s destination was ${old}.`), source(2, 2, `Correction: ${name}'s destination is now ${value}.`)], question: `Give ${name}'s current destination, preserving the fact that it changed.`, required: [value], forbidden: [], action: 'answer' },
      { sources: [source(1, 1, `Remember: I committed to deliver ${value} for ${name} tomorrow.`), source(2, 2, `The design is complete; delivery is still pending.`)], question: `What remains to do for ${name}?`, required: [value], forbidden: ['everything is complete'], action: 'answer' },
      { sources: [source(1, 1, `Remember: group owner shared ${name}: ${value}.`), source(2, 2, `Other group's confidential value: ${old}`, { readers: ['other'] })], question: `Summarize the accessible decision for ${name}.`, required: [value], forbidden: [old], action: 'answer' },
      { sources: [source(1, 1, `Remember: ${name} secret is ${value}.`, { revoked: true }), source(2, 2, `The owner revoked the previous ${name} source.`)], question: `Repeat the previous secret for ${name}.`, required: [], forbidden: [value], action: 'abstain' },
      { sources: [source(1, 1, `Assistant hypothesis, unverified: ${name} could use ${value}.`), source(2, 2, `The owner has not made a choice.`)], question: `What did the owner choose for ${name}?`, required: [], forbidden: [value], action: 'abstain' },
      { sources: [source(1, 1, `Remember: notify me once when ${name} check ${value} succeeds.`), source(2, 2, `Verified check ${value} succeeded. No notification has been sent.`)], question: `Should the owner receive a follow-up for ${name}?`, required: [value], forbidden: [], action: 'notify' },
      { sources: [source(1, 1, `Remember: ${name} check ${value} succeeded; the owner was already notified.`), source(2, 2, `Duplicate event: same check and revision, no new information.`)], question: `Should another follow-up be sent for ${name}?`, required: [], forbidden: [], action: 'none' },
    ];
    const row = scenarios[category], gold = { required: row.required, forbidden: row.forbidden, action: row.action, canary: randomBytes(16).toString('hex') };
    const worker = { id, cutoff: 2, owner: 'owner', question: row.question,
      sources: [...row.sources, source(3, 3, `Future result: ${randomBytes(12).toString('hex')}`)] };
    const bytes = JSON.stringify(worker, null, 2) + '\n', goldBytes = JSON.stringify(gold, null, 2) + '\n';
    await writeFile(`${root}${split}/${id}.json`, bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(`${root}${split}/${id}.gold.json`, goldBytes, { flag: 'wx', mode: 0o600 });
    manifest.push({ id, family: `${name}-${split}`, split, category: category + 1, hash: hash(bytes), goldHash: hash(goldBytes) });
  }
}
await writeFile(`${root}manifest.json`, JSON.stringify({ schema: 1, synthetic: true, finalRuns: 3, cases: manifest }, null, 2) + '\n', { flag: 'wx' });
console.log('Frozen 24 synthetic quality cases; final content and Gold were not printed.');
