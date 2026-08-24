'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { ApiError } from '@tillgate/api-client';
import { adminApi } from './admin-api';

export async function retryDeadBillingRequest(input: {
  requestId: string;
  expectedRevision: number;
  reason: string;
  evidenceRefs?: string[];
}): Promise<{ error?: string }> {
  const t = await getTranslations('billingOperations');
  try {
    await adminApi().post(`/v1/billing-operations/${input.requestId}/retry`, {
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs ?? [],
    });
    revalidatePath('/dashboard/billing-operations');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('retryFailed') };
  }
}

/** 废弃 dead 单：确认不收费并释放全部预扣（与「重试」二选一） */
export async function abandonDeadBillingRequest(input: {
  requestId: string;
  expectedRevision: number;
  reason: string;
  evidenceRefs?: string[];
}): Promise<{ error?: string }> {
  const t = await getTranslations('billingOperations');
  try {
    await adminApi().post(`/v1/billing-operations/${input.requestId}/abandon`, {
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs ?? [],
    });
    revalidatePath('/dashboard/billing-operations');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('abandonFailed') };
  }
}
