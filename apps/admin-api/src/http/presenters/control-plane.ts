/**
 * 控制面域 presenter：providers/channels/channel-funds 行 → wire DTO 快照形状。
 * 行类型经 facade 返回面推断（Awaited<ReturnType>）——app 不 import 包内 store 类型。
 * wire 偏差（MIGRATION §4）：渠道行 cooldownUntil/providerBaseUrl/updatedAt 无列来源恒 null;
 * boundModels 为 v2 线形 string[]（绑定名清单——{externalName,realModel} 对待 control-plane 列表扩展）。
 */
import type { ControlPlane } from '@tokenlens/control-plane';
import { Decimal, normalizeAmount } from '@tokenlens/billing';
import { iso } from '../contracts/common';

export type ProviderRowSource = Awaited<ReturnType<ControlPlane['providers']['create']>>;
export type ChannelItemSource = Awaited<
  ReturnType<ControlPlane['channels']['list']>
>['rows'][number];
export type RechargeRowSource = Awaited<
  ReturnType<ControlPlane['channels']['listRecharges']>
>['rows'][number];

export function toProviderWireRow(row: ProviderRowSource) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    protocol: row.protocol,
    vendor: row.vendor,
    status: row.status,
    createdAt: iso(row.createdAt)!,
  };
}

export function toChannelWireRow(row: ChannelItemSource) {
  return {
    id: row.id,
    providerId: row.providerId,
    name: row.name,
    providerName: row.providerName,
    baseUrlOverride: row.baseUrlOverride,
    models: row.models,
    weight: row.weight,
    priority: row.priority,
    status: row.status,
    failCount: row.failCount,
    cooldownUntil: null,
    rpmLimit: row.rpmLimit,
    tpmLimit: row.tpmLimit,
    upstreamBudget: normalizeAmount(row.upstreamBudget),
    upstreamThreshold:
      row.upstreamThreshold === null ? null : normalizeAmount(row.upstreamThreshold),
    upstreamConsumed: normalizeAmount(row.upstreamConsumed),
    upstreamRemaining: new Decimal(row.upstreamBudget).minus(row.upstreamConsumed).toString(),
    createdAt: iso(row.createdAt)!,
    updatedAt: null,
    providerBaseUrl: null,
    boundModels: row.boundModels,
  };
}

export function toChannelFundWireRow(row: RechargeRowSource) {
  return {
    id: row.id,
    channelId: row.channelId,
    channelName: row.channelName,
    type: row.type as 'recharge' | 'adjust',
    amount: normalizeAmount(row.amount),
    balanceAfter: normalizeAmount(row.balanceAfter),
    orderNo: row.orderNo,
    voucher: row.voucher,
    remark: row.remark,
    adminId: row.adminId,
    adminEmail: row.adminEmail,
    adminDisplayName: row.adminDisplayName,
    createdAt: iso(row.createdAt)!,
  };
}
