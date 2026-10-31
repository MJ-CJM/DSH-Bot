import { resolve } from 'node:path';
/** Shared isolated, provider-free profile for the B6b and B7 real CLI probes. */
export function mockProfilePatch(dir, probe, config, extra = []) {
  return [
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, 'storage'))}`,
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
    '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'synthetic-credentials.yml'))}`, '    watch: false',
    '- id: dsh-bot', '  config:', '    seedExamples: false', '    messagingEnabled: true',
    `    dataDir: ${JSON.stringify(resolve(dir, 'bots'))}`,
    '- id: agent-default-model', '  config:', '    provider: dp-b6b', '    model: fixture',
    '- id: user-approval', '  config:', '    policy: ask',
    ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
      'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    ...extra, '- insert:', '    - id: dp-mock-probe', `      name: ${JSON.stringify(resolve(probe))}`,
    '      config:', ...Object.entries(config).map(([name, value]) => `        ${name}: ${JSON.stringify(value)}`), '',
  ].join('\n');
}
