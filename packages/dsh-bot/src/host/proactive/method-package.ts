import { methodPackage, type ExportMethodRequest, type MethodPackage } from '../../shared/proactive/method-package.js';
import type { FeedbackCandidate } from '../../shared/proactive/feedback.js';
import { digest } from './wire.js';

/** Explicit public content only. No runtime IDs, private examples, grants or receipts are copied. */
export function exportMethod(candidate: FeedbackCandidate, request: ExportMethodRequest): MethodPackage {
  if (candidate.id !== request.candidateId || candidate.revision !== request.expectedRevision || candidate.bodyPurgedAt !== undefined || candidate.proposal.kind !== 'skill') throw new Error('Method candidate changed');
  const { name, content, beforeHash } = candidate.proposal;
  const manifest = methodPackage.shape.manifest.parse({ format: 'dsh-bot-method/v1', name, content, parentHash: beforeHash,
    contract: request.contract, dependencies: [{ name: 'dsh', version: '0.2.1-rc.2' }], examples: request.examples,
    publicContentConfirmed: request.publicContentConfirmed, evaluation: 'unverified',
    ...(candidate.methodEvaluation?.state === 'completed' && candidate.methodEvaluation.outcome ? { reportedEvidence: {
      judge: candidate.methodEvaluation.plan.judge, planDigest: candidate.methodEvaluation.digest,
      outcome: candidate.methodEvaluation.outcome, model: `${candidate.methodEvaluation.plan.provider}/${candidate.methodEvaluation.plan.model}`,
      runDigests: candidate.methodEvaluation.receipts.map(receipt => digest(receipt)),
    } } : {}) });
  return { manifest, digest: digest(manifest) };
}
export function readMethod(raw: MethodPackage) {
  const parsed = methodPackage.parse(raw);
  if (digest(parsed.manifest) !== parsed.digest) throw new Error('Method package integrity mismatch');
  return parsed.manifest;
}
