/**
 * 客户端安全类型（不依赖 "use server" 文件）。
 * 字段与 @ai-gateway/api-client 的 AppRow / AppCreated 完全对齐（全 camelCase）。
 */
export interface AppRow {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  description: string | null;
  scope: string | null;
  status: number;
  createdAt: string;
  rotatedAt: string | null;
}

export interface AppCreated {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  clientSecret: string;
}
