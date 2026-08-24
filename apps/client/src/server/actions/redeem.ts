'use server';

/** 兑换充值码：成功返回到账额与余额（页面即时反馈），并失效余额相关页。 */
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError, type RedeemResult } from '@tillgate/api-client';

import { createClientApi } from '../api';

export async function redeemAction(
  code: string,
): Promise<{ ok?: boolean; amount?: string; balanceAfter?: string; error?: string }> {
  const t = await getTranslations('redeem');
  const trimmed = code.trim();
  if (!trimmed) return { error: t('codeRequired') };
  try {
    const res = await createClientApi().post<RedeemResult>('/v1/redeem', { code: trimmed });
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/redeem');
    revalidatePath('/dashboard/transactions');
    return { ok: true, amount: res.amount, balanceAfter: res.balanceAfter };
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    return { error: t('redeemFailed') };
  }
}
