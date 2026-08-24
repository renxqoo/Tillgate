'use server';

/** 充值下单：返回支付跳转 URL（浏览器 window.location 跳转渠道收银台）。 */
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError, type TopupOrderResult } from '@tillgate/api-client';

import { createClientApi } from '../api';

export async function createPaymentAction(
  provider: 'epay' | 'stripe',
  amount: string,
): Promise<{ ok?: boolean; payUrl?: string; error?: string }> {
  try {
    const res = await createClientApi().post<TopupOrderResult>('/v1/payments/orders', {
      provider,
      amount,
    });
    revalidatePath('/dashboard/billing');
    return { ok: true, payUrl: res.payUrl };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    const t = await getTranslations('billing');
    return { error: t('orderFailed') };
  }
}
