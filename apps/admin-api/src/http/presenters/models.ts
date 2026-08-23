/**
 * 模型映射 presenter：ModelRecord → AdminModelRow（api-client DTO 快照形状）。
 * channelIds 由列表用例回显（无绑定 = 空数组——v1 语义）。
 */
import type { BillingConfig } from '@tokenlens/control-plane';
import { normalizeAmount } from '@tokenlens/billing';
import { iso } from '../contracts/common';

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

export function toModelWireRow(row: ModelRowSource, channelIds: readonly number[] = []) {
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
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    channelIds: [...channelIds],
  };
}
