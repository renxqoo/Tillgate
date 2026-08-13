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
    await adminFetch(`/api/admin/billing-operations/${input.requestId}/retry`, {
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

export async function confirmNoUpstreamCharge(input: {
  requestId: string;
  expectedRevision: number;
  reason: string;
  evidenceRefs?: string[];
}): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/billing-operations/${input.requestId}/resolve`, {
      method: 'POST',
      body: {
        decision: 'confirmed_no_charge',
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        evidenceRefs: input.evidenceRefs ?? [],
      },
    });
    revalidatePath('/dashboard/billing-operations');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : '复核提交失败' };
  }
}
