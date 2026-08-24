'use server';

/** 订阅 action：购买/变更（升级·扩容补差价）/续费。幂等键缺省服务端 uuid（契约语义）。 */
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';

import { createClientApi } from '../api';

export async function purchaseSubscriptionAction(
  planId: number,
  quantity = 1,
): Promise<{ error?: string }> {
  const t = await getTranslations('subscription');
  if (!planId) return { error: t('planRequired') };
  if (!Number.isInteger(quantity) || quantity < 1) return { error: t('seatsAtLeast1') };
  try {
    await createClientApi().post('/v1/subscriptions', { planId, quantity });
    revalidatePath('/dashboard/subscription');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('purchaseFailed') };
  }
}

export async function changeSubscriptionAction(
  id: number,
  input: { targetPlanId: number; quantity: number },
): Promise<{ error?: string }> {
  const t = await getTranslations('subscription');
  try {
    await createClientApi().post(`/v1/subscriptions/${id}/change`, input);
    revalidatePath('/dashboard/subscription');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('changeFailed') };
  }
}

export async function renewSubscriptionAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('subscription');
  try {
    await createClientApi().post(`/v1/subscriptions/${id}/renew`);
    revalidatePath('/dashboard/subscription');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('renewFailed') };
  }
}
