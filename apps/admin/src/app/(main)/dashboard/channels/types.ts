// client-safe 类型（不依赖 @ai-gateway/api-client）
export interface ChannelRow {
  id: number;
  providerId: number;
  name: string;
  baseUrlOverride: string | null;
  models: string | null;
  weight: number;
  priority: number;
  status: number;
  failCount: number;
  cooldownUntil: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 进货总额（元，numeric 字符串，0=未接入进货管理） */
  upstreamBudget: string;
  /** 熔断阈值（元，string | null） */
  upstreamThreshold: string | null;
  /** 已消耗上游成本（元，string） */
  upstreamConsumed: string;
  /** 剩余 = 进货 - 已消耗（元，string，可为负） */
  upstreamRemaining: string;
  createdAt: string;
  updatedAt: string;
  providerName: string;
  providerBaseUrl: string;
  boundModels: Array<{ externalName: string; realModel: string }>;
}

export interface ProviderOption {
  id: number;
  name: string;
  baseUrl: string;
  protocol: string;
  status: number;
}
