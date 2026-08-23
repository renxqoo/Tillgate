/**
 * MFA 验证:TOTP 步进单调 CAS(last_used_step < step;同码/旧码重放被拒)→
 * 失败落恢复码分支(哈希单次消费)→ 统一 invalid_totp_code(防枚举口径,B21)。
 * 码统一 trim + 大写。
 */
import { recoveryCodeHashOf } from '../domain/challenge.js';
import { identityErrors } from '../domain/errors.js';
import { assertUserId } from '../domain/identifier.js';
import { matchTotp } from './confirm-totp.js';
import type { IdentityUseCaseContext } from './context.js';

export async function verifyMfa(
  ctx: IdentityUseCaseContext,
  input: { userId: number; code: string },
): Promise<{ method: 'totp' | 'recovery' }> {
  const userId = assertUserId(input.userId);
  const row = await ctx.mfaStore.loadTotp(ctx.db, userId);
  if (row == null || row.confirmedAt == null) {
    throw identityErrors.business('totp_not_enrolled', { userId });
  }
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (code.length === 0) {
    throw identityErrors.business('invalid_totp_code', { userId });
  }

  // TOTP:窗口匹配 → 步进单调 CAS
  const step = matchTotp(ctx, row, code);
  if (step != null) {
    const advanced = await ctx.mfaStore.advanceTotpStep(ctx.db, { userId, step });
    if (advanced) {
      return { method: 'totp' };
    }
    // 步号不前进(同码重放/并发先消费)→ 落入恢复码分支,最终统一 InvalidTotpCode(B21)
  }

  // 恢复码:哈希单次消费(used_at CAS)
  const consumed = await ctx.mfaStore.consumeRecoveryCode(ctx.db, {
    userId,
    codeHash: recoveryCodeHashOf(code, ctx.config.codePepper),
  });
  if (consumed) {
    return { method: 'recovery' };
  }
  throw identityErrors.business('invalid_totp_code', { userId });
}
