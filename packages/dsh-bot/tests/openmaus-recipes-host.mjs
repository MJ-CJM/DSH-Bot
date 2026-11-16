import assert from 'node:assert/strict';
/** Invoked by the isolated frozen-package Host suite. No product source imports or cloud decider. */
export async function verify(ctx, config) {
  const groups = ctx.get('dshBotGroups'); assert.ok(groups);
  const ids = ['om-sql', 'om-css'], keys = [];
  for (const id of ids) {
    const existing = (await ctx.dshBots.list()).find(bot => bot.id === id);
    const bot = existing ?? await ctx.dshBots.create({ id, name: id === 'om-sql' ? 'SQL reviewer' : 'CSS reviewer',
      template: 'minimal', description: id === 'om-sql' ? 'database SQL' : 'browser CSS',
      persona: { prefix: `OPENMAUS_RECIPE_FIXTURE ${id}. Reply with a brief check result. Do not call tools.` },
      model: { provider: config.provider ?? 'dp-loopback', model: config.model ?? 'fixture' } });
    keys.push({ botId: bot.id, botCreatedAt: bot.createdAt });
  }
  let group = (await groups.list()).find(row => row.group.name === 'OpenMaus reusable team')?.group;
  if (!group) group = await groups.create({ operationId: 'openmaus-recipes-create', name: 'OpenMaus reusable team',
    members: keys, mode: 'natural', onDemand: true, memberRoles: [{ bot: keys[0], role: 'database SQL' }, { bot: keys[1], role: 'browser CSS' }], historyConfirmed: true });
  const key = { groupId: group.id, groupCreatedAt: group.createdAt };
  const beforePreferences = config.modelCalls?.();
  const recipe = await groups.teamRecipes.capture(key, 'OpenMaus portable team');
  assert.deepEqual(Object.keys(recipe).sort(), ['format', 'mode', 'name', 'onDemand', 'roles', 'version']);
  await assert.rejects(async () => groups.teamRecipes.save({ ...recipe, version: 2 }));
  await assert.rejects(async () => groups.teamRecipes.save({ ...recipe, memories: ['PRIVATE_CANARY'] }));
  const saved = await groups.teamRecipes.save(JSON.parse(JSON.stringify(recipe)));
  const preview = await groups.teamRecipes.preview(recipe);
  assert.ok(preview.roles.every(row => row.match === 'preferred' && row.capabilityMatch));
  const mapping = preview.roles.map(row => ({ roleId: row.roleId, bot: row.bot }));
  group = (await groups.view(key)).group;
  group = await groups.teamRecipes.apply(key, recipe, mapping, group.revision, group.membershipRevision);
  assert.equal(group.memberRoles.length, 2);
  if (beforePreferences !== undefined) assert.equal(config.modelCalls(), beforePreferences, 'Recipe capture/save/preview/apply starts no model');
  const members = (await groups.view(key)).members;
  const results = [];
  const send = async (tag, text, extra = {}) => {
    group = (await groups.view(key)).group;
    const before = config.modelCalls?.() ?? results.reduce((count, row) => count + (row.turn.routing.modelRequests ?? 0), 0);
    const turn = await groups.send(key, { operationId: `openmaus-${tag}-${Date.now()}`, expectedMembershipRevision: group.membershipRevision, text, ...extra });
    await groups.waitForTurn(turn.id);
    const view = await groups.view(key), done = view.turns.find(row => row.id === turn.id);
    group = view.group;
    assert.ok(!['accepted', 'running'].includes(done.state));
    assert.equal(done.routing.deciderCalls, 0);
    assert.ok(done.routing.modelRequests > 0, 'Observe actual native agent/request events');
    const after = config.modelCalls?.() ?? before + done.routing.modelRequests;
    assert.equal(after - before, done.routing.modelRequests, 'Native request count agrees with the synthetic adapter');
    results.push({ tag, beforeModelRequests: before, afterModelRequests: after, observedRequests: done.routing.modelRequests, turn: done, deliveries: view.deliveries.filter(row => row.turnId === turn.id) });
    return { done, view };
  };
  const css = members.find(row => row.bot.botId === 'om-css'), sql = members.find(row => row.bot.botId === 'om-sql');
  const selected = await send('role', 'Please review browser CSS');
  assert.deepEqual(selected.done.orderedMemberIds, [css.id]);
  assert.equal(selected.done.routing.reason, 'role-match');
  const explicit = await send('mention', 'Please review browser CSS', { memberIds: [sql.id] });
  assert.deepEqual(explicit.done.orderedMemberIds, [sql.id]); assert.equal(explicit.done.routing.reason, 'mention');
  const reply = selected.view.messages.find(row => row.turnId === selected.done.id && row.speaker);
  assert.ok(reply);
  const replied = await send('reply', 'Please review database SQL', { replyTo: reply.id });
  assert.deepEqual(replied.done.orderedMemberIds, [css.id]); assert.equal(replied.done.routing.reason, 'reply');
  assert.equal((await send('fallback', 'unrelated zzz question')).done.routing.reason, 'no-match');
  assert.equal((await send('round', 'Please review browser CSS', { round: true })).done.orderedMemberIds.length, 2);
  // Sending and native title synchronization can advance the group revision.
  // Read the exact current snapshot; retain both existing CAS checks.
  group = (await groups.view(key)).group;
  group = await groups.edit(key, { expectedRevision: group.revision, expectedMembershipRevision: group.membershipRevision,
    name: group.name, mode: group.mode, members: keys, historyConfirmed: true, onDemand: false });
  assert.equal((await send('disabled', 'Please review browser CSS')).done.orderedMemberIds.length, 2);
  return { status: 'PASS', group: key, groupName: group.name, rootSessionId: group.rootSessionId, recipeId: saved.id,
    recipe, results, realModelRequests: 0, browser: { menu: 'teams.title', dialog: '[data-team-recipes]', preview: '[data-team-preview]',
      capture: 'teams.capture', save: 'teams.save', apply: 'teams.apply', toggle: 'teams.onDemand' } };
}
