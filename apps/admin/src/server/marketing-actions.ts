'use server';

import { revalidatePath } from 'next/cache';

import { adminApi } from './admin-api';

export interface MarketingSettingsForm {
  signupGiftAmount: string;
  referralSignupBonus: string;
  referralCommissionRate: string;
}

/** 保存营销参数（PUT 后端域校验 + 审计）；失败抛错由 useActionResult 呈现 */
export async function saveMarketingSettingsAction(
  input: MarketingSettingsForm,
): Promise<{ ok: true }> {
  await adminApi().put('/v1/marketing/settings', input);
  revalidatePath('/dashboard/marketing');
  return { ok: true };
}
