import { randomUUID } from 'node:crypto';
import { teamMappingSchema, teamPreviewMappingSchema, teamRecipeSchema, type TeamPreview } from '../../shared/team-recipes.js';
import { groupMemberEditOptionsSchema, type GroupKey } from '../../shared/groups.js';
import { OperationError, parse, need } from '../common/operations.js';
import type { GroupState } from './state.js';
import type { GroupMembers } from './members.js';
import { sameBot } from './model.js';

/** Reuses Groups membership; applying preferences never starts an execution. */
export class TeamRecipes {
  constructor(private state: GroupState, private members: GroupMembers) {}
  list() { return this.state.queue.run(async () => {
    this.state.check();
    return [...this.state.table('team_recipes').entries()].map(([, row]) => row).sort((a, b) => b.savedAt - a.savedAt);
  }); }
  capture(key: GroupKey, name: string) { return this.state.queue.run(async () => {
    const group = this.state.record(key);
    const members = this.state.members(group).filter(row => row.enabled && row.removedAt === undefined).sort((a, b) => a.order - b.order);
    this.state.checkNewWorkMembers(group);
    const roles = await Promise.all(members.map(async (member, index) => {
      const bot = await this.state.bot(member.bot);
      return { id: `role-${index}`, role: group.memberRoles?.find(row => sameBot(row.bot, member.bot))?.role ?? bot.name,
        preferredBotId: bot.id, template: bot.template };
    }));
    return parse(teamRecipeSchema, { format: 'dsh-bot-team', version: 1, name, mode: group.mode, onDemand: group.onDemand ?? false, roles });
  }); }
  async save(value: unknown) {
    const recipe = parse(teamRecipeSchema, value);
    if (recipe.roles.length > this.state.memberLimit()) throw new OperationError('member-limit');
    return this.state.queue.run(async () => {
      this.state.check();
      const row = { id: `team:${randomUUID()}`, savedAt: Date.now(), recipe };
      await this.state.table('team_recipes').put(row.id, row);
      return row;
    });
  }
  remove(id: string) { return this.state.queue.run(async () => {
    this.state.check();
    await this.state.table('team_recipes').delete(id);
    return true;
  }); }
  async preview(value: unknown, mappings: unknown = []): Promise<TeamPreview> {
    this.state.check();
    const recipe = parse(teamRecipeSchema, value);
    if (recipe.roles.length > this.state.memberLimit()) throw new OperationError('member-limit');
    // Empty mappings request automatic suggestions. Partial manual maps are also useful for previews.
    const manual = parse(teamPreviewMappingSchema, mappings);
    if (new Set(manual.map(row => row.roleId)).size !== manual.length || manual.some(row => !recipe.roles.some(role => role.id === row.roleId))) throw new OperationError('invalid');
    const bots = await this.state.registry.list();
    const statuses = await this.state.registry.status();
    const candidates = bots.filter(bot => statuses.some(status => status.id === bot.id && status.preset.state === 'ok'));
    const used = new Set<string>();
    const roles = recipe.roles.map(role => {
      const requested = manual.find(row => row.roleId === role.id);
      const bot = requested ? candidates.find(bot => sameBot(requested.bot, { botId: bot.id, botCreatedAt: bot.createdAt })) :
        candidates.find(bot => bot.id === role.preferredBotId && !used.has(bot.id)) ??
        candidates.find(bot => bot.template === role.template && !used.has(bot.id));
      if (requested && !bot) throw new OperationError('invalid');
      if (bot) used.add(bot.id);
      return { roleId: role.id, ...(bot ? { bot: { botId: bot.id, botCreatedAt: bot.createdAt } } : {}),
        match: requested ? 'manual' as const : !bot ? 'unmapped' as const : bot.id === role.preferredBotId ? 'preferred' as const : 'capability' as const,
        capabilityMatch: bot?.template === role.template,
        candidates: candidates.map(bot => ({ bot: { botId: bot.id, botCreatedAt: bot.createdAt }, name: bot.name, template: bot.template })),
      };
    });
    return { recipe, roles };
  }
  async apply(key: GroupKey, value: unknown, mappings: unknown, expectedRevision: number, expectedMembershipRevision: number, historyConfirmed?: boolean) {
    const input = await this.applyInput(key, value, mappings, expectedRevision, expectedMembershipRevision, historyConfirmed);
    return this.members.edit(key, input);
  }
  async applyMembers(key: GroupKey, value: unknown, mappings: unknown, expectedRevision: number, expectedMembershipRevision: number, valueOptions: unknown) {
    const options = parse(groupMemberEditOptionsSchema, valueOptions);
    const input = await this.applyInput(key, value, mappings, expectedRevision, expectedMembershipRevision, options.historyConfirmed);
    return this.members.editRecipe(key, input, options.operationId,
      { source: 'team', recipe: parse(teamRecipeSchema, value), mappings: parse(teamMappingSchema, mappings), expectedRevision, expectedMembershipRevision, options });
  }
  private async applyInput(key: GroupKey, value: unknown, mappings: unknown, expectedRevision: number, expectedMembershipRevision: number, historyConfirmed?: boolean) {
    const recipe = parse(teamRecipeSchema, value);
    const group = await this.state.queue.run(async () => this.state.record(key));
    if (recipe.roles.length > this.state.memberLimit() && this.state.members(group).filter(member => member.removedAt === undefined).length <= this.state.memberLimit()) throw new OperationError('member-limit');
    const mapping = parse(teamMappingSchema, mappings);
    if (mapping.length !== recipe.roles.length || new Set(mapping.map(row => row.roleId)).size !== recipe.roles.length ||
        mapping.some(row => !recipe.roles.some(role => role.id === row.roleId)) ||
        new Set(mapping.map(row => row.bot.botId)).size !== mapping.length) throw new OperationError('invalid');
    const roles = recipe.roles.map(role => ({ bot: need(mapping.find(row => row.roleId === role.id)).bot, role: role.role }));
    if (group.supergroup) throw new OperationError('approval-denied');
    return { expectedRevision, expectedMembershipRevision, name: group.name,
      mode: recipe.mode, onDemand: recipe.onDemand, ...(historyConfirmed !== undefined ? { historyConfirmed } : {}),
      members: roles.map(row => row.bot), memberRoles: roles };
  }
}
