import { counters } from './eval-guard.mjs';
// Reject mode before loading schemas, datasets, environment, authorization or adapters.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--mode' || !['mock', 'replay'].includes(args[1])) {
  console.error('Only --mode mock|replay is supported; real is disabled'); process.exitCode = 1;
} else {
  try {
    const { runEvaluation } = await import('./eval-runner.mjs');
    console.log(JSON.stringify(await runEvaluation(args[1], counters)));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
