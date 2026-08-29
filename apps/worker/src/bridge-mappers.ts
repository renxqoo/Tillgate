/**
 * 装配桥接的形状映射（纯函数逐字段搬运）:
 * - toBillingEvent:inference 蛇形信号 → billing 点分事件（与 gateway 桥同款映射）
 * - toChannelCandidate:control-plane 渠道行 → inference 候选形状（连接信息同源映射）
 */
import type { BillingSignal, ChannelCandidate } from '@tillgate/inference';
import type { BillingEvent } from '@tillgate/billing';

export function toBillingEvent(signal: BillingSignal): BillingEvent {
  switch (signal.type) {
    case 'upstream_started': {
      return {
        type: 'upstream.started',
        requestId: signal.requestId,
        leaseOwner: signal.leaseOwner,
        leaseMs: signal.leaseMs,
      };
    }
    case 'lease_renewed': {
      return {
        type: 'lease.renewed',
        requestId: signal.requestId,
        leaseOwner: signal.leaseOwner,
        leaseMs: signal.leaseMs,
      };
    }
    case 'request_succeeded': {
      return {
        type: 'request.succeeded',
        requestId: signal.requestId,
        // 收据两包同源——结构直传
        receipt: signal.receipt as unknown as BillingEvent extends { receipt: infer R } ? R : never,
      };
    }
    case 'request_failed': {
      return { type: 'request.failed', requestId: signal.requestId, reason: signal.reason };
    }
  }
}

export function toChannelCandidate(
  row: {
    channelId: number;
    channelName: string;
    providerName: string | null;
    providerProtocol: string;
    providerVendor: string | null;
    baseUrlOverride: string | null;
    providerBaseUrl: string;
    apiKeyEnc: string;
    priority: number;
    weight: number;
    rpmLimit: number | null;
    tpmLimit: number | null;
    upstreamBudget: string;
  },
  /** 出站模型名（任务路径 = 任务行提交时快照；渠道行不持绑定名） */
  upstreamModel: string,
): ChannelCandidate {
  return {
    channelId: row.channelId,
    channelName: row.channelName,
    providerName: row.providerName,
    protocol: row.providerProtocol,
    vendor: row.providerVendor,
    baseUrl: row.baseUrlOverride ?? row.providerBaseUrl,
    apiKeyEnc: row.apiKeyEnc,
    upstreamModel,
    priority: row.priority,
    weight: row.weight,
    rpmLimit: row.rpmLimit,
    tpmLimit: row.tpmLimit,
    upstreamBudget: row.upstreamBudget,
  };
}
