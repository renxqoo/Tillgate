'use server';

/** Key 生命周期 action：创建（一次性明文）/修补（undefined 字段不发送）/吊销。 */
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError, type KeyCreated, type KeyRow } from '@tokenlens/api-client';

import { createClientApi } from '../api';

export async function createKeyAction(input: {
  name: string;
  remark?: string;
  subscriptionId?: number | null;
}): Promise<{ error?: string; key?: KeyCreated }> {
  const t = await getTranslations('keys');
  if (!input.name.trim()) return { error: t('nameRequired') };
  try {
    const key = await createClientApi().post<KeyCreated>('/v1/keys', {
      name: input.name.trim(),
      remark: input.remark?.trim() || undefined,
      subscriptionId: input.subscriptionId ?? null,
    });
    revalidatePath('/dashboard/keys');
    return { key };
  } catch (e) {
    const tCommon = await getTranslations('common');
    return { error: e instanceof ApiError ? e.message : tCommon('createFailed') };
  }
}

export async function updateKeyAction(
  id: number,
  input: {
    name?: string;
    remark?: string;
    rpmLimit?: number | null;
    tpmLimit?: number | null;
    dailySpendLimit?: string | null;
  },
): Promise<{ error?: string }> {
  const t = await getTranslations('common');
  try {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name.trim();
    if (input.remark !== undefined) body.remark = input.remark.trim() || null;
    if (input.rpmLimit !== undefined) body.rpmLimit = input.rpmLimit;
    if (input.tpmLimit !== undefined) body.tpmLimit = input.tpmLimit;
    if (input.dailySpendLimit !== undefined) body.dailySpendLimit = input.dailySpendLimit;
    await createClientApi().patch<KeyRow>(`/v1/keys/${id}`, body);
    revalidatePath('/dashboard/keys');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('updateFailed') };
  }
}

export async function revokeKeyAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('keys');
  try {
    await createClientApi().delete(`/v1/keys/${id}`);
    revalidatePath('/dashboard/keys');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('revokeFailed') };
  }
}
