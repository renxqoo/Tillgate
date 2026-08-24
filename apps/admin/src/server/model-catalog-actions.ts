'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import { adminApi } from './admin-api';

export interface CatalogImportModel {
  externalName: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  contextLength?: number | null;
}

/** 一键入库：channel 源建 provider/channel/mappings；reference 源落草稿（审批制） */
export async function importCatalogAction(input: {
  sourceId: string;
  apiKey?: string;
  models: CatalogImportModel[];
}): Promise<{ error?: string }> {
  const t = await getTranslations('modelMarket');
  if (input.models.length === 0) return { error: t('selectAtLeastOne') };
  if (!/^[a-z0-9-]{1,32}$/.test(input.sourceId)) return { error: t('invalidSource') };
  for (const m of input.models) {
    if (!m.externalName.trim() || !m.realModel.trim()) {
      return { error: t('namesRequired') };
    }
  }
  try {
    await adminApi().post('/v1/model-catalog/import', {
      sourceId: input.sourceId,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      models: input.models.map((m) => ({
        externalName: m.externalName.trim(),
        realModel: m.realModel.trim(),
        inputPrice: m.inputPrice,
        outputPrice: m.outputPrice,
        cacheInputPrice: m.cacheInputPrice,
        cacheWritePrice: m.cacheWritePrice,
        ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
      })),
    });
    revalidatePath('/dashboard/model-market');
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('importFailed') };
  }
}

/** 手动覆盖汇率（冻结基准直到清除；审计 fx.override） */
export async function setFxOverrideAction(rate: string): Promise<{ error?: string }> {
  const t = await getTranslations('modelMarket');
  try {
    await adminApi().put('/v1/fx/catalog/override', { rate });
    revalidatePath('/dashboard/model-market');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('overrideFailed') };
  }
}

/** 清除覆盖：回落自动拉取（立即补拉一次） */
export async function clearFxOverrideAction(): Promise<{ error?: string }> {
  const t = await getTranslations('modelMarket');
  try {
    await adminApi().delete('/v1/fx/catalog/override');
    revalidatePath('/dashboard/model-market');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('clearFailed') };
  }
}

/** 点差（%）：生效预填汇率 = 基准 ×(1+点差)；覆盖态不叠加 */
export async function setFxBufferAction(bufferPct: string): Promise<{ error?: string }> {
  const t = await getTranslations('modelMarket');
  try {
    await adminApi().put('/v1/fx/catalog/buffer', { bufferPct });
    revalidatePath('/dashboard/model-market');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('bufferFailed') };
  }
}

/** 强制刷新汇率（绕过 TTL 直拉 ECB） */
export async function refreshFxAction(force: boolean): Promise<{ error?: string }> {
  const t = await getTranslations('modelMarket');
  try {
    await adminApi().post('/v1/fx/catalog/refresh', { force });
    revalidatePath('/dashboard/model-market');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('refreshFailed') };
  }
}

export interface PriceHistoryEntry {
  action: string;
  createdAt: string;
  adminId: number | null;
  fx: {
    baseRate: string;
    effectiveRate: string | null;
    source: string | null;
    fetchedAt: string | null;
  } | null;
  catalogPrompt: string | null;
  catalogCompletion: string | null;
  prefillInputCny: string | null;
  submittedInputCny: string;
  submittedOutputCny: string;
}

/** 价格溯源：某对外名的历次目录导入/改价（目录原价 × 汇率 → 预填 → 提交 全链） */
export async function priceHistoryAction(
  externalName: string,
): Promise<{ entries?: PriceHistoryEntry[]; error?: string }> {
  const t = await getTranslations('modelMarket');
  if (!externalName.trim()) return { error: t('externalNameRequired') };
  try {
    const data = await adminApi().get<{ entries: PriceHistoryEntry[] }>(
      `/v1/model-catalog/price-history?externalName=${encodeURIComponent(externalName.trim())}`,
    );
    return { entries: data.entries };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('queryFailed') };
  }
}
