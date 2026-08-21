'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { adminFetch, ApiError } from '@ai-gateway/api-client';

// ── 创建模型映射 ────────────────────────────────────────────────────────────
export interface ModelCreateInput {
  externalName: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice?: string;
  cacheWritePrice?: string;
  /** 计价单位（token/image/second/char/request）；单位计价模型配 unitPrice */
  pricingUnit?: string;
  unitPrice?: string;
  /** 变体价格（分辨率差价）：strategy=variant + selector + prices */
  billingConfig?: { strategy?: string; params?: { selector?: string; prices?: Record<string, string> } };
  isFree?: boolean;
  contextLength?: number | null;
  billingPolicy?: Record<string, unknown> | null;
}

export async function createModelAction(input: ModelCreateInput): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  const tc = await getTranslations('common');
  if (!input.externalName.trim() || !input.realModel.trim()) {
    return { error: t('nameRequired') };
  }
  try {
    await adminFetch('/v1/models', {
      method: 'POST',
      body: {
        externalName: input.externalName.trim(),
        realModel: input.realModel.trim(),
        inputPrice: input.inputPrice,
        outputPrice: input.outputPrice,
        cacheInputPrice: input.cacheInputPrice ?? '0',
        ...(input.cacheWritePrice != null ? { cacheWritePrice: input.cacheWritePrice } : {}),
        pricingUnit: input.pricingUnit ?? 'token',
        ...(input.unitPrice != null ? { unitPrice: input.unitPrice } : {}),
        ...(input.billingConfig != null ? { billingConfig: input.billingConfig } : {}),
        isFree: input.isFree ?? false,
        ...(input.contextLength != null ? { contextLength: input.contextLength } : {}),
        billingPolicy: input.billingPolicy ?? null,
      },
    });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('createFailed') };
  }
}

// ── 编辑模型映射 ────────────────────────────────────────────────────────────
export interface ModelUpdateInput {
  externalName?: string;
  realModel?: string;
  inputPrice?: string;
  outputPrice?: string;
  cacheInputPrice?: string;
  cacheWritePrice?: string;
  /** 计价单位（token/image/second/char/request）；单位计价模型配 unitPrice */
  pricingUnit?: string;
  unitPrice?: string;
  /** 变体价格（分辨率差价）：strategy=variant + selector + prices；null = 清除（回到统一单价） */
  billingConfig?: { strategy?: string; params?: { selector?: string; prices?: Record<string, string> } } | null;
  isFree?: boolean;
  contextLength?: number | null;
  fallbackModels?: string;
  paramRules?: string;
  billingPolicy?: Record<string, unknown> | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  status?: number;
}

export async function updateModelAction(
  id: number,
  input: ModelUpdateInput,
): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminFetch(`/v1/models/${id}`, { method: 'PATCH', body: input });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('saveFailed') };
  }
}

// ── 删除模型映射 ────────────────────────────────────────────────────────────
/** 下架（软删除）：status→1，不再对外提供；历史计费/渠道绑定保留——非物理删除 */
export async function deleteModelAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  try {
    await adminFetch(`/v1/models/${id}`, { method: 'DELETE' });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('delistFailed') };
  }
}

/** 恢复上架：status→0（走编辑表单同款 PATCH） */
export async function restoreModelAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  try {
    await adminFetch(`/v1/models/${id}`, { method: 'PATCH', body: { status: 0 } });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('restoreFailed') };
  }
}

// ── 绑定渠道 ────────────────────────────────────────────────────────────────
export async function bindChannelsAction(
  id: number,
  channelIds: number[],
): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  try {
    await adminFetch(`/v1/models/${id}/channels`, {
      method: 'POST',
      // 标准契约（与 admin-api models.ts 的 bindChannelsSchema 一致）：
      // { channels: [{channelId, weight?, priority?}] }，全量替换语义
      body: { channels: channelIds.map((channelId) => ({ channelId })) },
    });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('bindFailed') };
  }
}

// ── 模型级测试（最小生成探针：逐绑定渠道真实生成 "1" + max_tokens 1） ────────
export interface ModelTestResult {
  channelId: number;
  channel: string;
  ok: boolean;
  durationMs: number;
  tokens?: number;
  error?: { code: string; message: string };
}

export async function testModelAction(id: number): Promise<
  { results?: ModelTestResult[]; error?: string }
> {
  const t = await getTranslations('models');
  try {
    const data = await adminFetch<{ results: ModelTestResult[] }>(
      `/v1/models/${id}/test`,
      { method: 'POST' },
    );
    return { results: data.results };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('testFailed') };
  }
}
