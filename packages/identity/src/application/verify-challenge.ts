/**
 * 验码:CAS 三态翻译 + 可选目标归属比对(防跨 kind/跨主体重放)。
 * 死因统一口径:不存在/已消费/已作废/已过期/耗尽 = challenge_invalid,不细分。
 */
import { auditEvent } from '../domain/audit-events.js';
import { codeHashOf } from '../domain/challenge.js';
import { identityErrors } from '../domain/errors.js';
import { isUuidLike, normalizeIdentifier } from '../domain/identifier.js';
import type { ChallengeTarget } from '../domain/challenge.js';
import type { StoredChallengeTarget } from '../ports/challenge-store.js';
import type { IdentityUseCaseContext } from './context.js';
import { recordAudit } from './context.js';

export interface VerifyChallengeInput {
  readonly challengeId: string;
  readonly code: string;
  /** 归属比对:验到的目标必须与期望一致,否则按挑战无效拒绝 */
  readonly expect?: ChallengeTarget;
}

export interface VerifyChallengeResult {
  readonly target: StoredChallengeTarget;
  readonly payload: Record<string, unknown> | null;
}

function targetMatches(
  ctx: IdentityUseCaseContext,
  expect: ChallengeTarget,
  actual: StoredChallengeTarget,
): boolean {
  if ('identifier' in expect && expect.identifier != null) {
    const norm = normalizeIdentifier(expect.identifier, ctx.guards);
    return (
      actual.identifier != null &&
      actual.identifier.kind === norm.kind &&
      actual.identifier.value === norm.value
    );
  }
  if ('userId' in expect) {
    return actual.identifier == null && actual.userId === expect.userId;
  }
  return false;
}

export async function verifyChallenge(
  ctx: IdentityUseCaseContext,
  input: VerifyChallengeInput,
): Promise<VerifyChallengeResult> {
  const challengeId = typeof input?.challengeId === 'string' ? input.challengeId : '';
  if (!isUuidLike(challengeId)) {
    throw identityErrors.business('challenge_invalid', { challengeId: challengeId || '<missing>' });
  }
  const code = typeof input?.code === 'string' ? input.code.trim() : '';
  const outcome = await ctx.challengeStore.verifyChallenge(ctx.db, {
    challengeId,
    codeHash: codeHashOf(code, challengeId, ctx.config.codePepper),
  });
  if (outcome.status === 'invalid') {
    throw identityErrors.business('challenge_invalid', { challengeId });
  }
  if (outcome.status === 'wrong_code') {
    if (outcome.remainingAttempts === 0) {
      // 错次耗尽:统一 invalid 口径
      throw identityErrors.business('challenge_invalid', { challengeId });
    }
    throw identityErrors.business('code_invalid', { remainingAttempts: outcome.remainingAttempts });
  }
  if (input.expect != null && !targetMatches(ctx, input.expect, outcome.target)) {
    throw identityErrors.business('challenge_invalid', { challengeId });
  }
  await recordAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: 'system',
      action: 'challenge.verify',
      targetType: 'challenge',
      targetId: challengeId,
      detail: { kind: 'verified' },
    }),
  );
  return { target: outcome.target, payload: outcome.payload };
}
