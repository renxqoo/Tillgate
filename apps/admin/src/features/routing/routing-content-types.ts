/**
 * 智能路由视图类型。
 * ChannelOverviewView = wire 快照（@tillgate/api-client 生成 DTO，单一真相在
 * admin-api openapi registry——与后端漂移由生成链门禁锁定）。
 * RoutingPolicyView/PolicyForm 是前端表单形态：policy 保持 Record<string, unknown>
 * 防御收窄（formOf 运行时解析），不绑定结构化 wire 类型。
 */
import type { RoutingOverviewRow } from '@tillgate/api-client';

export type { RoutingOverviewRow };

export type ChannelOverviewView = RoutingOverviewRow;

export interface RoutingPolicyView {
  version: string;
  policy: Record<string, unknown>;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface PolicyForm {
  cacheAffinityEnabled: boolean;
  cacheBoost: string;
  budgetWatermarkEnabled: boolean;
  softRatio: string;
  sameChannelMaxRetries: string;
  rateLimitBaseMs: string;
  rateLimitMaxMs: string;
  quotaMs: string;
  conditionalBypass: boolean;
  modelDeadThreshold: string;
  waitEnabled: boolean;
  maxWaitMs: string;
}
