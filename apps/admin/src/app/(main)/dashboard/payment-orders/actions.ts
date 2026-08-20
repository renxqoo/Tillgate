'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, adminFetch } from '@ai-gateway/api-client';

export async function closePaymentOrderAction(orderId: string): Promise<{ error?: string }> {
  try {
    await adminFetch(`/v1/payment-orders/${orderId}/close`, { method: 'POST' });
    revalidatePath('/dashboard/payment-orders');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : '关闭失败' };
  }
}
