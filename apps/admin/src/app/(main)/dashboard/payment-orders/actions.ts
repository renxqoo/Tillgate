'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError, adminFetch } from '@ai-gateway/api-client';

export async function closePaymentOrderAction(orderId: string): Promise<{ error?: string }> {
  const t = await getTranslations('paymentOrders');
  try {
    await adminFetch(`/v1/payment-orders/${orderId}/close`, { method: 'POST' });
    revalidatePath('/dashboard/payment-orders');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('closeFailed') };
  }
}
