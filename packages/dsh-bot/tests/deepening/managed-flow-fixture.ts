import { EgressChecker } from '../../src/host/data-flow/egress.js';
import { ManagedOutlets } from '../../src/host/data-flow/outlets.js';
import { OnceGrants } from '../../src/host/data-flow/grants.js';
import { MemoryLineage } from '../../src/host/data-flow/lineage.js';
import { v2Fixture } from './v2-fixtures.js';
import { shared } from './shared-fixtures.js';
export const alpha = { botId: 'alpha', botCreatedAt: 1 }, beta = { botId: 'beta', botCreatedAt: 2 };
export async function flowFixture() {
  const f = await v2Fixture();
  const current = new Map([['alpha', 1], ['beta', 2]]);
  const create = () => {
    const grants = new OnceGrants(f.kernel);
    const checker = new EgressChecker(f.kernel, grants, key => current.get(key.botId) === key.botCreatedAt);
    return new ManagedOutlets(checker);
  };
  let flow = create();
  const sharedId = await shared(f, 'SYNTHETIC_SHARED_CONTROL'), privateId = (await f.alpha.save({ content: 'PRIVATE_CANARY_B6B' })).id;
  const seed = async (session: string, id: string) => {
    const version = f.kernel.snapshot.versions.get(id); if (!version) throw new Error('Missing fixture version');
    const label = await new MemoryLineage(f.kernel).record(session, [version.versionId]); await flow.inherit(session, label);
  };
  await seed('clean', sharedId); await seed('private', privateId);
  return { f, current, sharedId, privateId, seed, get flow() { return flow; },
    registry: () => ({ memoryKernel: f.kernel, memoryOutlets: flow }) as import('../../src/host/registry.js').DshBotRegistry,
    async reopen() { await flow.close(); flow.checker.close(); await f.reopen(); flow = create(); await flow.recover(); },
    async close() { await flow.close(); flow.checker.close(); await f.close(); } };
}
