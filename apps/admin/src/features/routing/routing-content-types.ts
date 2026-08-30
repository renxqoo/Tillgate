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

/**
 * 预算降权阈值快照（观测表预算列高亮依据——页面层从策略体防御解析，
 * 未配置时 API 携带编译期缺省）。enabled=false 时展示层不做阈值高亮。
 */
export interface BudgetWatermarkHint {
  enabled: boolean;
  /** remaining/budget 比例阈值（与 budgetWatermark scorer 同源） */
  softRatio: number;
}

export interface RoutingPolicyView {
  version: string;
  policy: Record<string, unknown>;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface PolicyForm {
  /** 智能路由总开关：false = 单渠道直连（不换渠道），scorer/韧性参数不生效 */
  enabled: boolean;
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
