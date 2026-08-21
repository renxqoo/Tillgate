'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, adminFetch } from '@ai-gateway/api-client';

export async function retryDeadBillingRequest(input: {
  requestId: string;
  expectedRevision: number;
  reason: string;
  evidenceRefs?: string[];
}): Promise<{ error?: string }> {
  try {
    await adminFetch(`/v1/billing-operations/${input.requestId}/retry`, {
      method: 'POST',
      body: {
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        evidenceRefs: input.evidenceRefs ?? [],
      },
    });
    revalidatePath('/dashboard/billing-operations');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : '重试提交失败' };
  }
}


/** 废弃 dead 单：确认不收费并释放全部预扣（与「重试」二选一） */
export async function abandonDeadBillingRequest(input: {
  requestId: string;
  expectedRevision: number;
  reason: string;
  evidenceRefs?: string[];
}): Promise<{ error?: string }> {
  try {
    await adminFetch(`/v1/billing-operations/${input.requestId}/abandon`, {
      method: 'POST',
      body: {
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        evidenceRefs: input.evidenceRefs ?? [],
      },
    });
    revalidatePath('/dashboard/billing-operations');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : '废弃提交失败' };
  }
}
