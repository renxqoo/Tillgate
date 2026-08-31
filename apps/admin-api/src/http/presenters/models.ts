/**
 * 模型映射 presenter：ModelRecord → AdminModelRow（api-client DTO 快照形状）。
 * channels 绑定回显（渠道 + 出站模型名；无绑定 = 空数组）。
 */
import type { BillingConfig } from '@tillgate/control-plane';
import { normalizeAmount } from '@tillgate/billing';
import { iso, isoRequired } from '../contracts/common';

export interface ModelRowSource {
  readonly id: number;
  readonly externalName: string;
  readonly realModel: string;
  readonly contextLength: number | null;
  readonly status: number;
  readonly inputPrice: string;
  readonly outputPrice: string;
  readonly cacheInputPrice: string;
  readonly cacheWritePrice: string;
  readonly pricingUnit: string;
  readonly unitPrice: string;
  readonly billingConfig: BillingConfig;
  readonly isFree: boolean;
  readonly billingPolicy: Record<string, unknown> | null;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  /** 记录面逻辑删除时刻（回收站）；null = 在册 */
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 绑定行 → wire channels 项（成本面透传：可空列判空后 normalizeAmount 砍尾零；
 * 曾在此被截成两字段导致弹窗成本回显恒空——回归锚点） */
function toBindingWireChannels(
  channels: ReadonlyArray<{
    channelId: number;
    upstreamModel: string;
    costInputPrice: string | null;
    costOutputPrice: string | null;
    costCacheInputPrice: string | null;
    costCacheWritePrice: string | null;
    costUnitPrice: string | null;
    costConfig: Record<string, unknown>;
  }>,
) {
  return channels.map((c) => ({
    channelId: c.channelId,
    upstreamModel: c.upstreamModel,
    costInputPrice: c.costInputPrice == null ? null : normalizeAmount(c.costInputPrice),
    costOutputPrice: c.costOutputPrice == null ? null : normalizeAmount(c.costOutputPrice),
    costCacheInputPrice:
      c.costCacheInputPrice == null ? null : normalizeAmount(c.costCacheInputPrice),
    costCacheWritePrice:
      c.costCacheWritePrice == null ? null : normalizeAmount(c.costCacheWritePrice),
    costUnitPrice: c.costUnitPrice == null ? null : normalizeAmount(c.costUnitPrice),
    costConfig: c.costConfig,
  }));
}

export function toModelWireRow(
  row: ModelRowSource,
  channels: ReadonlyArray<{
    channelId: number;
    upstreamModel: string;
    costInputPrice: string | null;
    costOutputPrice: string | null;
    costCacheInputPrice: string | null;
    costCacheWritePrice: string | null;
    costUnitPrice: string | null;
    costConfig: Record<string, unknown>;
  }> = [],
) {
  return {
    id: row.id,
    externalName: row.externalName,
    realModel: row.realModel,
    inputPrice: normalizeAmount(row.inputPrice),
    outputPrice: normalizeAmount(row.outputPrice),
    cacheInputPrice: normalizeAmount(row.cacheInputPrice),
    cacheWritePrice: normalizeAmount(row.cacheWritePrice),
    pricingUnit: row.pricingUnit,
    unitPrice: normalizeAmount(row.unitPrice),
    billingConfig: row.billingConfig,
    isFree: row.isFree,
    contextLength: row.contextLength,
    fallbackModels: null,
    paramRules: null,
    billingPolicy: row.billingPolicy,
    rpmLimit: row.rpmLimit,
    tpmLimit: row.tpmLimit,
    status: row.status,
    deletedAt: iso(row.deletedAt),
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    channels: toBindingWireChannels(channels),
  };
}
