import { it } from 'vitest';
const path = './properties-run.mjs';
const { runProperties } = await import(path);
it('I48 runs 5000 complete memory model sequences, preserving seed and shrunk failures', async () => {
  await runProperties('memory');
}, 600000);
