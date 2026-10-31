import { it } from 'vitest';
const path = './properties-run.mjs';
const { runProperties } = await import(path);
it('I49 runs 5000 complete egress/grant/quota model sequences, preserving seed and shrunk failures', async () => {
  await runProperties('egress');
}, 600000);
