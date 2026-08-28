'use server';
import { adminApi } from './admin-api';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';

/** 汇率状态读（GET /v1/fx/catalog——funds:read） */
export async function getFxStateAction(): Promise<{
  state?: {
    mode: 'auto' | 'override';
    baseRate: string | null;
    effectiveRate: string | null;
    bufferPct: string;
    source: string | null;
    fetchedAt: string | null;
  };
  error?: string;
}> {
  try {
    const state = await adminApi().get<{
      mode: 'auto' | 'override';
      baseRate: string | null;
      effectiveRate: string | null;
      bufferPct: string;
      source: string | null;
      fetchedAt: string | null;
    }>('/v1/fx/catalog');
    return { state };
  } catch {
    return { error: 'unavailable' };
  }
}

/** 手动覆盖汇率（PUT /v1/fx/catalog/override——funds:fx） */
export async function setFxOverrideAction(rate: string): Promise<{ ok?: true; error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().put('/v1/fx/catalog/override', { rate } satisfies { rate: string });
    revalidatePath('/dashboard/funds');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('actionFailed') };
  }
}

/** 清除覆盖回 auto（DELETE /v1/fx/catalog/override——funds:fx） */
export async function clearFxOverrideAction(): Promise<{ ok?: true; error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().delete('/v1/fx/catalog/override');
    revalidatePath('/dashboard/funds');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('actionFailed') };
  }
}

/** 点差设置（PUT /v1/fx/catalog/buffer——funds:fx） */
export async function setFxBufferAction(bufferPct: string): Promise<{ ok?: true; error?: string }> {
  const tc = await getTranslations('common');
  if (!/^-?\d{1,5}(?:\.\d{1,3})?$/.test(bufferPct)) {
    return { error: 'invalidBuffer' };
  }
  try {
    await adminApi().put('/v1/fx/catalog/buffer', { bufferPct } satisfies { bufferPct: string });
    revalidatePath('/dashboard/funds');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('actionFailed') };
  }
}

/** 强制刷新基准（POST /v1/fx/catalog/refresh——funds:fx） */
export async function refreshFxAction(): Promise<{ ok?: true; error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().post('/v1/fx/catalog/refresh', { force: true } satisfies { force: boolean });
    revalidatePath('/dashboard/funds');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('actionFailed') };
  }
}

/** 平台币种读（GET /v1/settings/platform-currency——funds:floor） */
export async function getPlatformCurrencyAction(): Promise<{
  currency?: string;
  error?: string;
}> {
  try {
    const res = await adminApi().get<{ currency: string }>('/v1/settings/platform-currency');
    return { currency: res.currency };
  } catch {
    return { error: 'unavailable' };
  }
}

/** 平台币种写（写一次——处女系统才可改;非处女 409 由后端裁决透传） */
export async function updatePlatformCurrencyAction(currency: string): Promise<{
  ok?: true;
  error?: string;
}> {
  const tc = await getTranslations('common');
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { error: 'invalidCurrency' };
  }
  try {
    await adminApi().put('/v1/settings/platform-currency', { currency } satisfies { currency: string });
    revalidatePath('/dashboard/funds');
    return { ok: true };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('actionFailed') };
  }
}
