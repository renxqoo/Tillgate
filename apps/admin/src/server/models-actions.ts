'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import { adminApi } from './admin-api';

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
  /** 计费配置：variant=分辨率差价（selector+prices）/ schedule=分时段窗口（windows） */
  billingConfig?: {
    strategy?: string;
    params?: {
      selector?: string;
      prices?: Record<string, string>;
      windows?: Array<Record<string, string>>;
    };
  };
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
    await adminApi().post('/v1/models', {
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
    });
    revalidatePath('/dashboard/models');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('createFailed') };
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
  /** 计费配置：variant=差价 / schedule=分时段；null = 清除（回到基价列） */
  billingConfig?: {
    strategy?: string;
    params?: {
      selector?: string;
      prices?: Record<string, string>;
      windows?: Array<Record<string, string>>;
    };
  } | null;
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
    await adminApi().patch(`/v1/models/${id}`, input);
    revalidatePath('/dashboard/models');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : tc('saveFailed') };
  }
}

// ── 下架/上架（status 语义；下架≠删除——记录仍在列表可见） ────────────────────
/** 下架：status→1，不再对外提供；历史计费/渠道绑定保留（走编辑同款 PATCH） */
export async function delistModelAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  try {
    await adminApi().patch(`/v1/models/${id}`, { status: 1 });
    revalidatePath('/dashboard/models');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('delistFailed') };
  }
}

/** 上架：status→0（走编辑表单同款 PATCH） */
export async function restoreModelAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  try {
    await adminApi().patch(`/v1/models/${id}`, { status: 0 });
    revalidatePath('/dashboard/models');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('restoreFailed') };
  }
}

// ── 删除（逻辑删除/回收站）与恢复记录 ────────────────────────────────────────
/** 删除记录：status→1 + deleted_at；记录与绑定保留可追溯，外部名释放可复用 */
export async function deleteModelAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  try {
    await adminApi().delete(`/v1/models/${id}`);
    revalidatePath('/dashboard/models');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('deleteFailed') };
  }
}

/** 恢复已删除记录：回下架态（不直接上架——复核后显式上架） */
export async function undeleteModelAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  try {
    await adminApi().post(`/v1/models/${id}/restore`);
    revalidatePath('/dashboard/models');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('undeleteFailed') };
  }
}

// ── 绑定渠道 ────────────────────────────────────────────────────────────────
/** 绑定行成本覆盖价（numeric 字符串；'' = 继承映射官方价，契约层空串归一 null） */
export interface BindChannelItem {
  channelId: number;
  /** 留空 = 服务端物化映射规范名 */
  upstreamModel?: string;
  costInputPrice?: string;
  costOutputPrice?: string;
  costCacheInputPrice?: string;
  costCacheWritePrice?: string;
  costUnitPrice?: string;
  /** 成本侧计费配置（schedule 峰谷成本 / variant 差价成本；缺省 '{}' = 无策略） */
  costConfig?: {
    strategy?: string;
    params?: {
      selector?: string;
      prices?: Record<string, string>;
      windows?: Array<Record<string, string>>;
    };
  };
  /** 成本免费显式标记（价格列保持继承默认；true = 成本恒 0——业务判定源） */
  costIsFree?: boolean;
}

/** 渠道绑定（全量覆盖原绑定；upstreamModel 留空 = 服务端物化映射规范名） */
export async function bindChannelsAction(
  id: number,
  channels: BindChannelItem[],
): Promise<{ error?: string }> {
  const t = await getTranslations('models');
  try {
    await adminApi().post(`/v1/models/${id}/channels`, { channels });
    revalidatePath('/dashboard/models');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('bindFailed') };
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

export async function testModelAction(
  id: number,
): Promise<{ results?: ModelTestResult[]; error?: string }> {
  const t = await getTranslations('models');
  try {
    const data = await adminApi().post<{ results: ModelTestResult[] }>(`/v1/models/${id}/test`);
    return { results: data.results };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('testFailed') };
  }
}
