/**
 * 仅 TOTP 的 step-up 验证（敏感设置操作二次确认）：
 * 与 verifyMfa 的差异——不落恢复码分支（恢复码留给紧急登录，日常操作
 * 不得消耗）；步进单调 CAS 防重放（同 30 秒窗的码不可复用）与登录面同口径。
 * 错误口径统一 invalid_totp_code；未绑定 totp_not_enrolled（调用方转引导）。
 */
import { identityErrors } from '../domain/errors.js';
import { assertUserId } from '../domain/identifier.js';
import { matchTotp } from './confirm-totp.js';
import type { IdentityUseCaseContext } from './context.js';

export async function verifyTotpOnly(
  ctx: IdentityUseCaseContext,
  input: { userId: number; code: string },
): Promise<void> {
  const userId = assertUserId(input.userId);
  const row = await ctx.mfaStore.loadTotp(ctx.db, userId);
  if (row == null || row.confirmedAt == null) {
    throw identityErrors.business('totp_not_enrolled', { userId });
  }
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (code.length === 0) {
    throw identityErrors.business('invalid_totp_code', { userId });
  }
  const step = matchTotp(ctx, row, code);
  if (step == null) {
    throw identityErrors.business('invalid_totp_code', { userId });
  }
  const advanced = await ctx.mfaStore.advanceTotpStep(ctx.db, { userId, step });
  if (!advanced) {
    // 步号不前进（同码重放/并发先消费）——与 verifyMfa 同口径，不区分暴露时序
    throw identityErrors.business('invalid_totp_code', { userId });
  }
}
