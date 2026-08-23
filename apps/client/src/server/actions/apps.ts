'use server';

/** 应用生命周期 action：创建（client_secret 一次性明文）/轮换 secret/停用（语义删除）。 */
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError, type AppCreated } from '@tokenlens/api-client';

import { createClientApi } from '../api';

export async function createAppAction(input: {
  name: string;
  description?: string;
}): Promise<{ error?: string; app?: AppCreated }> {
  const t = await getTranslations('apps');
  if (!input.name.trim()) return { error: t('nameRequired') };
  try {
    const app = await createClientApi().post<AppCreated>('/v1/apps', {
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
    });
    revalidatePath('/dashboard/apps');
    return { app };
  } catch (e) {
    const tCommon = await getTranslations('common');
    return { error: e instanceof ApiError ? e.message : tCommon('createFailed') };
  }
}

export async function rotateSecretAction(id: number): Promise<{
  error?: string;
  clientSecret?: string;
}> {
  const t = await getTranslations('apps');
  try {
    const res = await createClientApi().post<{ clientSecret: string }>(`/v1/apps/${id}/rotate`);
    revalidatePath('/dashboard/apps');
    return { clientSecret: res.clientSecret };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('rotateFailed') };
  }
}

export async function deleteAppAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('common');
  try {
    // 删除 = 停用（应用不物理删除——历史计费归属保留）
    await createClientApi().post(`/v1/apps/${id}/disable`);
    revalidatePath('/dashboard/apps');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('deleteFailed') };
  }
}
