'use server';
import { adminApi } from './admin-api';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';

// ── 续费 ─────────────────────────────────────────────────────────────────────
export async function renewSubscriptionAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('subscriptions');
  try {
    await adminApi().post(`/v1/subscriptions/${id}/renew`);
    revalidatePath('/dashboard/subscriptions');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('renewFailed') };
  }
}

// ── 取消 ─────────────────────────────────────────────────────────────────────
export async function cancelSubscriptionAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('subscriptions');
  try {
    await adminApi().post(`/v1/subscriptions/${id}/cancel`);
    revalidatePath('/dashboard/subscriptions');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('cancelFailed') };
  }
}

// ── 变更（升级 / 扩容补差价）────────────────────────────────────────────────
export interface SubscriptionChangeInput {
  targetPlanId: number;
  quantity: number;
}

export async function changeSubscriptionAction(
  id: number,
  input: SubscriptionChangeInput,
): Promise<{ error?: string }> {
  const t = await getTranslations('subscriptions');
  try {
    await adminApi().post(`/v1/subscriptions/${id}/change`, input);
    revalidatePath('/dashboard/subscriptions');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('changeFailed') };
  }
}
