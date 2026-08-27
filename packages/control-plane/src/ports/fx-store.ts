/**
 * FxStore port：目录汇率的持久化边界。
 * 真相在 fx_rates 追加表（只增不改）；system_configs['catalog_fx'] 只是运行态缓存视图。
 * 进程内 TTL 缓存不在此（只服务网关热路径；admin 语义恒 force 读）。
 */
import type { DbLike } from '@tillgate/db';

export interface FxCurrentRow {
  /** 基准市场汇率（1 USD = ? CNY；不含点差——点差是定价决策，只进导入 provenance） */
  readonly rate: string;
  /** fx_rates 追加表行 id（来源/时间/操作人真相） */
  readonly fxRateId: number;
  readonly source: string;
  readonly fetchedAt: string;
}

export interface FxStore {
  /**
   * 当前生效基准汇率（override 优先回落最近 auto 行；无任何行 = null，消费方降级）。
   * 配置缓存行与追加表不一致时以追加表为准（真相在 fx_rates）。
   */
  current(db: DbLike): Promise<FxCurrentRow | null>;
  /** 追加一行汇率（fx_rates 只增不改——auto 拉取与 manual 覆盖共用） */
  insertRate(
    db: DbLike,
    input: {
      rate: string;
      source: string;
      mode: 'auto' | 'override';
      operatorAdminId?: number | null;
    },
  ): Promise<{ id: number }>;
  /** catalog_fx 配置读（缓存视图；真相在 fx_rates 与审计） */
  readConfig(db: DbLike): Promise<Record<string, unknown> | null>;
  /** catalog_fx 配置写（upsert；merged 由调用方算好） */
  upsertConfig(
    db: DbLike,
    input: { value: Record<string, unknown>; adminId: number | null },
  ): Promise<void>;
}
