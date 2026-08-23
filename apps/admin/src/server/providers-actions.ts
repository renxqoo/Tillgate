'use server';
import { adminApi } from './admin-api';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tokenlens/api-client';
import { SUPPORTED_PROTOCOLS } from '@/config/protocols';

export interface ProviderInput {
  name: string;
  baseUrl: string;
  protocol?: string;
  /** 厂商档案（空串 = 不设置/清除——纯透传） */
  vendor?: string | null;
  status?: number;
}

export async function createProviderAction(input: ProviderInput): Promise<{ error?: string }> {
  const t = await getTranslations('providers');
  const tc = await getTranslations('common');
  if (!input.name?.trim()) return { error: t('nameRequired') };
  if (!input.baseUrl?.trim()) return { error: t('baseUrlRequired') };
  try {
    await adminApi().post('/v1/providers', {
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      protocol: input.protocol?.trim() || SUPPORTED_PROTOCOLS[0]!,
      vendor: input.vendor?.trim() ? input.vendor.trim() : null,
      status: input.status ?? 0,
    });
    revalidatePath('/dashboard/providers');
    revalidatePath('/dashboard/channels');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('createFailed') };
  }
}

export async function updateProviderAction(
  id: number,
  input: Partial<ProviderInput>,
): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().patch(`/v1/providers/${id}`, input);
    revalidatePath('/dashboard/providers');
    revalidatePath('/dashboard/channels');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('saveFailed') };
  }
}

export async function deleteProviderAction(id: number): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().delete(`/v1/providers/${id}`);
    revalidatePath('/dashboard/providers');
    revalidatePath('/dashboard/channels');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('deleteFailed') };
  }
}
