/** 作废挑战:幂等(非法 id/已消费/已作废/不存在 → false;已消费不可作废——终态互斥) */
import { auditEvent } from '../domain/audit-events.js';
import { isUuidLike } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';
import { recordAudit } from './context.js';

export async function abortChallenge(
  ctx: IdentityUseCaseContext,
  input: { challengeId: string },
): Promise<{ aborted: boolean }> {
  const challengeId = typeof input?.challengeId === 'string' ? input.challengeId : '';
  if (!isUuidLike(challengeId)) {
    // v1 语义:非法 id 静默幂等(不泄露挑战存在性)
    return { aborted: false };
  }
  const result = await ctx.challengeStore.abortChallenge(ctx.db, { challengeId });
  await recordAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: 'system',
      action: 'challenge.abort',
      targetType: 'challenge',
      targetId: challengeId,
      detail: { aborted: result.aborted },
    }),
  );
  return result;
}
