/**
 * 客户端安全类型（不依赖 "use server" 文件）。
 * 字段与 @ai-gateway/api-client 的 KeyRow 完全对齐（全 camelCase）。
 */
export interface KeyRow {
  id: number;
  keyPreview: string;
  name: string;
  remark: string | null;
  status: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** Key 级每日花费上限（元，NULL=不限）。 */
  dailySpendLimit: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface KeyCreated {
  id: number;
  name: string;
  /** 明文 key，仅创建时返回 */
  key: string;
}
