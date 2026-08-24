'use server';

/** Key 生命周期 action：创建（一次性明文）/修补（undefined 字段不发送）/吊销/全量导出。 */
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError, type KeyCreated, type KeyRow } from '@tillgate/api-client';

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

/** 全量导出翻页参数：每页 100；总量上限 1000 防失控（超限时截断导出前 1000 条）。 */
const EXPORT_PAGE_SIZE = 100;
const EXPORT_MAX_KEYS = 1000;

/**
 * B18 增强：导出当前列表全量——经 list 动词循环翻页取满 total，而非仅当前页 20 条。
 * 页面级导出语义保留（G1 筛选契约落地前列表无筛选，导出即全部 Key）。
 */
export async function exportKeysAction(): Promise<{ error?: string; rows?: KeyRow[] }> {
  try {
    const api = createClientApi();
    const rows: KeyRow[] = [];
    // total 首轮未知，以 +∞ 进入循环，由第一页响应的 total 收敛
    let total = Number.POSITIVE_INFINITY;
    for (let page = 1; rows.length < total && rows.length < EXPORT_MAX_KEYS; page += 1) {
      const res = await api.list<KeyRow>('/v1/keys', { page, pageSize: EXPORT_PAGE_SIZE });
      rows.push(...res.rows);
      total = res.total;
      // 空页防御：total 异常（如大于真实存量）时后端返回空页，立即终止防死循环
      if (res.rows.length === 0) break;
    }
    return { rows };
  } catch (e) {
    const tCommon = await getTranslations('common');
    return { error: e instanceof ApiError ? e.message : tCommon('loadFailed') };
  }
}
