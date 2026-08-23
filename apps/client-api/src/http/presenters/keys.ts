/**
 * Key/App 呈现：能力包记录 → wire 行（内部字段 userId/allowPaygFallback/keyHash 等不出面）。
 * 入参用本地结构形状（accounts 根出口不导 port 行类型——结构兼容即成立）。
 */

/** api-client KeyRow 口径（不含 allowPaygFallback——内部计费语义不出 wire） */
export interface KeyRow {
  id: number;
  keyPreview: string;
  name: string;
  remark: string | null;
  subscriptionId: number | null;
  status: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  dailySpendLimit: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface KeyRecordView {
  id: number;
  keyPreview: string;
  name: string;
  remark: string | null;
  subscriptionId: number | null;
  status: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  dailySpendLimit: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** App scope 形状（accounts AppScope 的本地结构视图） */
export interface AppScopeView {
  models?: readonly string[];
  rpm?: number;
  tpm?: number;
}

/** api-client AppRow 口径（不含 userId/subscriptionId 内部字段） */
export interface AppRow {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  description: string | null;
  scope: AppScopeView | null;
  status: number;
  createdAt: Date;
  rotatedAt: Date | null;
}

export interface AppRecordView {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  description: string | null;
  scope: AppScopeView | null;
  status: number;
  createdAt: Date;
  rotatedAt: Date | null;
}

export function toKeyRow(r: KeyRecordView): KeyRow {
  return { ...r };
}

export function toAppRow(r: AppRecordView): AppRow {
  return { ...r };
}
