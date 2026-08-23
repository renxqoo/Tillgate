/**
 * P4 ops 读侧 wire 投影:用量行 / 生成任务行 / 支付订单行 → v1 wire 形状。
 * 时间口径:任务行 port 侧是 epoch ms(包内惯例),wire 转 ISO 字符串
 * (v1 JSON 序列化 Date 的产物——前端按 ISO 消费,保持兼容);
 * Date 列一律 iso() 收口(货币金额保持十进制字符串)。
 */
import type { UsageAdminRow } from '@tokenlens/observability';
import type { GenerationTaskAdminRow } from '@tokenlens/inference';
import type { AdminPaymentOrderRow } from '@tokenlens/billing';
import { iso } from '../contracts/common';

export function toUsageWireRow(row: UsageAdminRow) {
  return { ...row, createdAt: iso(row.createdAt)! };
}

export function toTaskWireRow(row: GenerationTaskAdminRow, settledAmount: string | null) {
  return {
    id: row.taskId,
    requestId: row.requestId,
    kind: row.kind,
    status: row.status,
    userId: row.userId,
    channelId: row.channelId,
    upstreamTaskId: row.upstreamTaskId,
    failReason: row.failReason,
    result: row.result,
    billingStatus: row.billingStatus,
    // 已结算任务的实扣金额(未结算/无账单行 = null;页内批量回填)
    settledAmount,
    createdAt: new Date(row.createdAt).toISOString(),
    finishedAt: row.finishedAt == null ? null : new Date(row.finishedAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

export function toOrderWireRow(row: AdminPaymentOrderRow) {
  return {
    ...row,
    createdAt: iso(row.createdAt)!,
    paidAt: iso(row.paidAt),
    creditedAt: iso(row.creditedAt),
  };
}
