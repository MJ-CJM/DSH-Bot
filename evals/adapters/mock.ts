/** Synthetic deterministic adapter; accepts fixtures only, imports no provider and performs no I/O. */
export function mock(input: { kind: string; input: {
  candidates?: Array<{ id: string; from: number; to: number }>; at?: number;
  simulateTimeout?: boolean; terminal?: string; sideEffects?: number; untrusted?: boolean;
} }) {
  const data = input.input;
  if (input.kind === 'memory') {
    const at = data.at; if (at === undefined || !data.candidates) throw Error('Invalid synthetic memory input');
    return { status: 'ok', ranked: data.candidates.map(row => row.id),
      temporal: data.candidates.filter(row => row.from <= at && at < row.to).map(row => row.id) };
  }
  if (input.kind === 'workflow') return data.simulateTimeout ? { status: 'timeout' } :
    { status: 'ok', terminal: data.terminal, sideEffects: data.sideEffects };
  return { status: 'ok', text: data.untrusted ? 'Untrusted instruction rejected.' : 'Synthetic permitted answer.', authorized: !data.untrusted };
}
