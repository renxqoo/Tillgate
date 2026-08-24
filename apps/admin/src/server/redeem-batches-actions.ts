'use server';
import { adminApi } from './admin-api';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';

// ── 生成批次 ────────────────────────────────────────────────────────────────
export interface BatchGenerateInput {
  name: string;
  amount: string;
  count: number;
  remark?: string;
  expiresAt?: string;
}

export interface BatchGenerated {
  batch: { id: number; name: string; amount: string; total: number };
  codes: string[];
}

export async function generateBatchAction(
  input: BatchGenerateInput,
): Promise<{ error?: string; batch?: BatchGenerated }> {
  const t = await getTranslations('redeemBatches');
  if (!/^\d{1,20}(?:\.\d{1,18})?$/.test(input.amount) || /^0+(?:\.0+)?$/.test(input.amount)) {
    return { error: t('amountPositive') };
  }
  if (input.count <= 0 || input.count > 1000) return { error: t('countRange') };
  if (!input.name?.trim()) return { error: t('nameRequired') };
  try {
    const res = await adminApi().post<BatchGenerated>('/v1/redeem-batches', {
      name: input.name.trim(),
      remark: input.remark?.trim() || undefined,
      amount: input.amount,
      count: input.count,
      expiresAt: input.expiresAt || undefined,
    });
    revalidatePath('/dashboard/redeem-batches');
    return { batch: res };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('generateFailed') };
  }
}

// ── 撤销充值码 ──────────────────────────────────────────────────────────────
export async function revokeCodeAction(codeId: number): Promise<{ error?: string }> {
  const t = await getTranslations('redeemBatches');
  try {
    await adminApi().post(`/v1/redeem-batches/codes/${codeId}/revoke`);
    revalidatePath('/dashboard/redeem-batches');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('revokeFailed') };
  }
}
