'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tokenlens/api-client';
import { adminApi } from './admin-api';

export async function closePaymentOrderAction(orderId: string): Promise<{ error?: string }> {
  const t = await getTranslations('paymentOrders');
  try {
    await adminApi().post(`/v1/payment-orders/${orderId}/close`);
    revalidatePath('/dashboard/payment-orders');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('closeFailed') };
  }
}
