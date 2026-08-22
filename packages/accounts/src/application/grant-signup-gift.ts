/**
 * 开户赠送(v1 注册链路 best-effort 段):金额取 marketing_settings 现值
 * (0=关闭,不调入账);幂等锚 gift/signup:{userId} 由实现方自然键保证,
 * 重放返回 replayed=true。失败**不回滚建号**——调用方(completeAccountOnboarding
 * 或 identity 桥接)决定吞错语义。
 */
import { isPositiveAmount } from '../domain/limits.js';
import { signupGiftRefId } from '../domain/referral.js';
import type { UseCaseContext } from './context.js';

export interface SignupGiftResult {
  readonly credited: boolean;
  readonly replayed: boolean;
}

export async function grantSignupGift(
  ctx: UseCaseContext,
  userId: number,
): Promise<SignupGiftResult> {
  const settings = await ctx.store.getMarketingSettings(ctx.db);
  if (!isPositiveAmount(settings.signupGiftAmount)) return { credited: false, replayed: false };

  const result = await ctx.walletCredit.credit(ctx.db, {
    refType: 'gift',
    refId: signupGiftRefId(userId),
    userId,
    amount: settings.signupGiftAmount,
    memo: '注册赠送',
  });
  return { credited: true, replayed: result.replayed };
}
