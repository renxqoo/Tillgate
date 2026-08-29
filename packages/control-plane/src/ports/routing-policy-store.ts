import type { DbLike } from '@tillgate/db';

/**
 * 路由策略存储 port：热配置持久面的消费方定义。
 * 策略体形状单一真相在 @tillgate/inference routingPolicySchema（本 port 只搬运
 * 已校验的 JSONB——校验职责在写入口 admin-api）。
 */
export interface RoutingPolicyRecord {
  id: number;
  scope: string;
  version: string;
  policy: Record<string, unknown>;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface SaveRoutingPolicyInput {
  /** routingPolicySchema.parse 后的策略体（admin-api 校验） */
  policy: Record<string, unknown>;
  note?: string;
  updatedBy?: string;
}

export interface RoutingPolicyStore {
  findGlobal(db: DbLike): Promise<RoutingPolicyRecord | null>;
  /**
   * upsert global 行并返回落库后记录（version 自增；note/updatedBy 未传保留旧值）。
   * 返回恒非空——落库失败以抛错表达，由用例层翻译为业务错误。
   */
  saveGlobal(db: DbLike, input: SaveRoutingPolicyInput): Promise<RoutingPolicyRecord>;
}
