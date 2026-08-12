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
