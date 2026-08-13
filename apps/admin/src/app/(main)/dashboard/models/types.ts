// client-safe 类型（不依赖 @ai-gateway/api-client）
export interface ModelRow {
  id: number;
  externalName: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  fallbackModels: string | null;
  paramRules: string | null;
  billingPolicy: Record<string, unknown> | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: number;
  createdAt: string;
  updatedAt: string;
  channelIds: number[];
}

export interface ChannelOption {
  id: number;
  name: string;
  providerName: string;
}
