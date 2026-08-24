'use server';
import { adminApi } from './admin-api';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';

// ── 创建费率卡 ──────────────────────────────────────────────────────────────
export interface RateCardCreateInput {
  name: string;
  coefficient: string;
  description?: string;
}

export async function createRateCardAction(
  input: RateCardCreateInput,
): Promise<{ error?: string }> {
  const t = await getTranslations('rateCards');
  const tc = await getTranslations('common');
  if (!input.name.trim()) return { error: t('nameRequired') };
  try {
    await adminApi().post('/v1/rate-cards', {
      name: input.name.trim(),
      coefficient: input.coefficient,
      description: input.description?.trim() || undefined,
    });
    revalidatePath('/dashboard/rate-cards');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('createFailed') };
  }
}

// ── 编辑费率卡 ──────────────────────────────────────────────────────────────
export interface RateCardUpdateInput {
  name?: string;
  description?: string;
  status?: number;
  coefficient?: string;
}

export async function updateRateCardAction(
  id: number,
  input: RateCardUpdateInput,
): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().patch(`/v1/rate-cards/${id}`, input);
    revalidatePath('/dashboard/rate-cards');
    revalidatePath(`/dashboard/rate-cards/${id}`);
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}

// ── 删除费率卡 ──────────────────────────────────────────────────────────────
export async function deleteRateCardAction(id: number): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().delete(`/v1/rate-cards/${id}`);
    revalidatePath('/dashboard/rate-cards');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('deleteFailed') };
  }
}
