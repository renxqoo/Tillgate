'use server';
import { adminApi } from './admin-api';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';

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
      // protocol 缺省不补——v1 前端 SUPPORTED_PROTOCOLS[0] 默认改由 control-plane
      // defaultProtocol('openai-compatible')兜底（词表不在 app 复制,P6/D1）
      ...(input.protocol?.trim() ? { protocol: input.protocol.trim() } : {}),
      vendor: input.vendor?.trim() ? input.vendor.trim() : null,
      status: input.status ?? 0,
    });
    revalidatePath('/dashboard/providers');
    revalidatePath('/dashboard/channels');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('createFailed') };
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
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}

/** 删除记录（逻辑删除/回收站）：status→1 + deleted_at；行与渠道引用保留，名称释放可复用 */
export async function deleteProviderAction(id: number): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().delete(`/v1/providers/${id}`);
    revalidatePath('/dashboard/providers');
    revalidatePath('/dashboard/channels');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('deleteFailed') };
  }
}

/** 恢复已删除记录：回禁用态（不直接启用——复核后显式启用） */
export async function undeleteProviderAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('providers');
  try {
    await adminApi().post(`/v1/providers/${id}/restore`);
    revalidatePath('/dashboard/providers');
    revalidatePath('/dashboard/channels');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('undeleteFailed') };
  }
}
