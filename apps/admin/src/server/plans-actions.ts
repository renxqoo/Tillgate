'use server';
import { adminApi } from './admin-api';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';

// ── 创建套餐 ─────────────────────────────────────────────────────────────────
export interface PlanCreateInput {
  name: string;
  kind?: 'subscription' | 'pack';
  sortOrder?: number | null;
  price: string;
  /** 包月 1~3650；加油包 0 */
  periodDays: number;
  quotaAmount: string;
  allowSeats?: boolean;
}

export async function createPlanAction(input: PlanCreateInput): Promise<{ error?: string }> {
  const t = await getTranslations('plans');
  const tc = await getTranslations('common');
  if (!input.name.trim()) return { error: t('nameRequired') };
  try {
    await adminApi().post('/v1/plans', {
      name: input.name.trim(),
      kind: input.kind ?? 'subscription',
      sortOrder: input.sortOrder ?? null,
      price: input.price,
      periodDays: input.periodDays,
      quotaAmount: input.quotaAmount,
      allowSeats: input.allowSeats ?? false,
    });
    revalidatePath('/dashboard/plans');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('createFailed') };
  }
}

// ── 编辑套餐 ─────────────────────────────────────────────────────────────────
export interface PlanUpdateInput {
  name?: string;
  sortOrder?: number | null;
  price?: string;
  periodDays?: number;
  quotaAmount?: string;
  allowSeats?: boolean;
  status?: number;
}

export async function updatePlanAction(
  id: number,
  input: PlanUpdateInput,
): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().patch(`/v1/plans/${id}`, input);
    revalidatePath('/dashboard/plans');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('saveFailed') };
  }
}

// ── 删除套餐 ─────────────────────────────────────────────────────────────────
export async function deletePlanAction(id: number): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().delete(`/v1/plans/${id}`);
    revalidatePath('/dashboard/plans');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('deleteFailed') };
  }
}

// ── 发放加油包（仅 kind=pack 的套餐）────────────────────────────────────────
export async function grantPackAction(planId: number, userId: number): Promise<{ error?: string }> {
  const t = await getTranslations('plans');
  if (!Number.isInteger(userId) || userId <= 0) return { error: t('invalidUserId') };
  try {
    await adminApi().post(`/v1/subscriptions/${planId}/grant`, { userId });
    revalidatePath('/dashboard/plans');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('grantFailed') };
  }
}
