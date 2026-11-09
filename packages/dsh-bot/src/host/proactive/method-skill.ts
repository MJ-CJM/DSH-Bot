import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { MethodTrial } from '../../shared/proactive/method-evaluation.js';
import { digest } from './wire.js';

// Structural subset of the pinned public dsh-skill API. No internal imports.
interface NativeSkills {
  register(skill: { name: string; description: string; content: string; source: string; provider: string }): () => void;
  get(name: string, options: { scope: Agent; cwd: string; signal: AbortSignal }): Promise<{ name: string; content: string; provider: string } | undefined>;
}
export const methodBody = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim() || 'No additional method.';
export const evaluationSkillName = (trial: MethodTrial) => `evaluation-${trial.planDigest.slice(0, 32)}`;
export function registerMethodSkill(ctx: Context, trial: MethodTrial) {
  if (digest(trial.content) !== trial.methodHash) throw new Error('Method content changed');
  const skills = ctx.get('skills') as NativeSkills | undefined;
  if (!skills) throw new Error('Native skill registry unavailable');
  return skills.register({ name: evaluationSkillName(trial), description: 'Owner-approved frozen method evaluation', content: methodBody(trial.content), source: 'runtime', provider: 'dsh-bot-method-evaluation' });
}
export async function loadMethodSkill(agent: Agent, trial: MethodTrial, cwd: string, signal: AbortSignal) {
  const skills = agent.ctx.get('skills') as NativeSkills | undefined;
  const loaded = await skills?.get(evaluationSkillName(trial), { scope: agent, cwd, signal });
  if (loaded?.provider !== 'dsh-bot-method-evaluation' || loaded.content !== methodBody(trial.content)) throw new Error('Native method activation not proven');
  return loaded.content;
}
