export interface BotKey {
  botId: string;
  botCreatedAt: number;
}

export interface Assignment {
  ticketId: string;
  assignmentId: string;
  effectId: string;
  bot: BotKey;
  policyRevision: number;
  action: string;
  target: string;
  dataScope: string;
  modelBudget: number;
}

export interface Grant {
  bot: BotKey;
  revision: number;
  action: string;
  target: string;
  dataScope: string;
  expiresAt: number;
  modelBudget: number;
  revoked?: boolean;
}

const sameBot = (a: BotKey, b: BotKey) => a.botId === b.botId && a.botCreatedAt === b.botCreatedAt;

// This fixture deliberately owns only one local deterministic action. It is
// a deployment grant, separate from any upstream prototype Mandate or model input.
export function rejectReason(assignment: Assignment, currentBot: BotKey, grant: Grant | undefined, now: number) {
  if (!grant) return 'no-grant';
  if (grant.revoked) return 'revoked';
  if (grant.expiresAt <= now) return 'expired';
  if (!sameBot(assignment.bot, currentBot) || !sameBot(grant.bot, currentBot)) return 'bot-generation';
  if (grant.revision !== assignment.policyRevision) return 'policy-revision';
  if (grant.action !== assignment.action || assignment.action !== 'fixture-read') return 'action';
  if (grant.target !== assignment.target || assignment.target !== 'fixture-local') return 'target';
  if (grant.dataScope !== assignment.dataScope || assignment.dataScope !== 'synthetic') return 'data-scope';
  if (!Number.isSafeInteger(assignment.modelBudget) || assignment.modelBudget < 1 ||
    assignment.modelBudget > grant.modelBudget) return 'budget';
  return undefined;
}
