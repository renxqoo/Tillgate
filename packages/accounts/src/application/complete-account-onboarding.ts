/**
 * 建号收尾组合件(v1 createAccountAndSession 的 best-effort 段):
 * 赠送失败不阻断建号、归因 catch 全吞——两段都**不抛**,结果记入报告
 * (v1 语义:幂等键可补发/归因可丢弃)。基础设施错误同样吞下并记录 code。
 */
import { isBusinessError } from '@tokenlens/errors';
import { grantSignupGift } from './grant-signup-gift.js';
import { applyReferral } from './apply-referral.js';
import type { UseCaseContext } from './context.js';

export interface OnboardingReport {
  readonly gift: { status: 'credited' | 'disabled' | 'failed'; replayed?: boolean; code?: string };
  readonly referral:
    | { status: 'skipped' }
    | { status: 'applied'; bonusCredited: boolean }
    | { status: 'rejected'; code: string }
    | { status: 'failed'; code: string };
}

export async function completeAccountOnboarding(
  ctx: UseCaseContext,
  input: { userId: number; affCode?: string },
): Promise<OnboardingReport> {
  let gift: OnboardingReport['gift'];
  try {
    const result = await grantSignupGift(ctx, input.userId);
    gift = result.credited
      ? { status: 'credited', replayed: result.replayed }
      : { status: 'disabled' };
  } catch (error) {
    gift = { status: 'failed', code: errCode(error) };
  }

  let referral: OnboardingReport['referral'];
  if (input.affCode === undefined) {
    referral = { status: 'skipped' };
  } else {
    try {
      const result = await applyReferral(ctx, { inviteeUserId: input.userId, affCode: input.affCode });
      referral = { status: 'applied', bonusCredited: result.bonusCredited };
    } catch (error) {
      referral = {
        status: isBusinessError(error) ? 'rejected' : 'failed',
        code: errCode(error),
      };
    }
  }
  return { gift, referral };
}

function errCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'unknown';
}
