'use server';
import { adminApi } from './admin-api';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';

// ── 用户调账 ────────────────────────────────────────────────────────────────
export async function adjustBalanceAction(
  id: number,
  input: { amount: string; remark: string },
): Promise<{ error?: string }> {
  const t = await getTranslations('users');
  if (!/^-?\d+(?:\.\d+)?$/.test(input.amount) || Number(input.amount) === 0) {
    return { error: t('adjustNonZero') };
  }
  try {
    await adminApi().post(`/v1/users/${id}/adjust`, {
      amount: input.amount,
      remark: input.remark?.trim() || undefined,
    });
    revalidatePath('/dashboard/users');
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('adjustFailed') };
  }
}

// ── 重置密码 ────────────────────────────────────────────────────────────────
export async function setPasswordAction(
  id: number,
  input: { password: string },
): Promise<{ error?: string }> {
  const t = await getTranslations('users');
  if (!input.password || input.password.length < 6) {
    return { error: t('passwordMin6') };
  }
  try {
    await adminApi().post(`/v1/users/${id}/set-password`, { password: input.password });
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('setPasswordFailed') };
  }
}

// ── 赠送余额 ────────────────────────────────────────────────────────────────
export async function giftUserAction(
  id: number,
  input: { amount: string; remark: string },
): Promise<{ error?: string }> {
  const t = await getTranslations('users');
  if (!/^\d+(?:\.\d+)?$/.test(input.amount) || Number(input.amount) <= 0) {
    return { error: t('giftPositive') };
  }
  try {
    await adminApi().post(`/v1/users/${id}/gift`, {
      amount: input.amount,
      remark: input.remark?.trim() || undefined,
    });
    revalidatePath('/dashboard/users');
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('giftFailed') };
  }
}

// ── 封禁 / 解封 + 冻结原因 ─────────────────────────────────────────────────
export async function setUserStatusAction(
  id: number,
  input: { status: number; freezeReason?: string },
): Promise<{ error?: string }> {
  const t = await getTranslations('common');
  try {
    await adminApi().patch(`/v1/users/${id}`, {
      status: input.status,
      ...(input.freezeReason !== undefined ? { freezeReason: input.freezeReason } : {}),
    });
    revalidatePath('/dashboard/users');
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('actionFailed') };
  }
}

// ── 设为 / 取消 企业用户 ────────────────────────────────────────────────────
export async function setUserEnterpriseAction(
  id: number,
  isEnterprise: boolean,
): Promise<{ error?: string }> {
  const t = await getTranslations('common');
  try {
    await adminApi().patch(`/v1/users/${id}`, { isEnterprise });
    revalidatePath('/dashboard/users');
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('actionFailed') };
  }
}

// ── 绑定费率卡 ──────────────────────────────────────────────────────────────
export async function bindRateCardAction(
  id: number,
  rateCardId: number | null,
): Promise<{ error?: string }> {
  const t = await getTranslations('users');
  try {
    await adminApi().patch(
      `/v1/users/${id}`,
      rateCardId === null ? { rateCardId: null } : { rateCardId },
    );
    revalidatePath('/dashboard/users');
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('bindFailed') };
  }
}
