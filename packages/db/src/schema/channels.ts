import {
  pgTable,
  bigserial,
  varchar,
  smallint,
  timestamp,
  bigint,
  text,
  numeric,
  index,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { jsonb } from './jsonb.js';
import { sql } from 'drizzle-orm';
import { providers } from './providers.js';

/**
 * channels — 渠道（供应商 × 上游 Key）
 * status: 0 启用 / 1 禁用 / 2 维护 / 3 熔断(自动) / 4 凭据无效（连续 401/403，换 Key 后恢复）
 */
export const channels = pgTable(
  'channels',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    providerId: bigint('provider_id', { mode: 'number' })
      .notNull()
      .references(() => providers.id),
    name: varchar('name', { length: 64 }).notNull(),
    /** AES-GCM 加密后的上游 Key（密钥在环境变量） */
    apiKeyEnc: text('api_key_enc').notNull(),
    baseUrlOverride: varchar('base_url_override', { length: 255 }),
    /**
     * 上游模型名白名单；NULL 或空数组 = 不限；非空时路由取「映射渠道列表 ∩ 白名单」
     * ——交集按绑定行 upstream_model 匹配（findRouteCandidates SQL 单点收口）
     */
    models: jsonb('models').$type<string[]>(),
    weight: bigint('weight', { mode: 'number' }).notNull().default(1),
    priority: bigint('priority', { mode: 'number' }).notNull().default(0),
    status: smallint('status').notNull().default(0),
    /** 连续失败次数（熔断判定，仅计 circuitTrip 错误） */
    failCount: bigint('fail_count', { mode: 'number' }).notNull().default(0),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    /** 渠道级限流（保护上游配额） */
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    /**
     * 当前余额（元）= 渠道「有没有钱」的唯一依据。入货 +、调账 ±、结算时按实际上游成本原子扣减。
     * 余额 ≤ 0 即「没钱」，路由精确硬闸拦截新请求；余额可为负（历史/在途超支）。
     */
    upstreamBudget: numeric('upstream_budget', { precision: 38, scale: 18 }).notNull().default('0'),
    /**
     * 熔断阈值（元）。剩余 ≤ 此值 → 自动熔断（status=3）+ 清路由缓存。
     * NULL = 0（耗尽才熔断）。仅 upstream_budget > 0 时生效。
     */
    upstreamThreshold: numeric('upstream_threshold', { precision: 38, scale: 18 }),
    /**
     * 用量证据缺陷计数：结算验收门对上游发票的钳制次数（谎报/虚报）。
     * 计数 ≥ 装配阈值 → 熔断（status=3）。运营手动复位（调零）后可重新启用。
     */
    usageEvidenceDefects: bigint('usage_evidence_defects', { mode: 'number' }).notNull().default(0),
    /**
     * 在途上游成本敞口（元）。路由选渠时原子累加本次上游预估，结算/释放时原子扣减。
     * 仅 upstream_budget > 0 的渠道启用（精确硬闸）；与 billing_requests.channel_reserved_amount 对应。
     */
    upstreamReserved: numeric('upstream_reserved', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    /**
     * 记录面逻辑删除（回收站）：NULL = 在册；非空 = 已删除（历史绑定/资金流水/FK 引用
     * 保留可追溯）。删除同时强制 status=1；恢复记录回禁用态。渠道名唯一约束为部分索引
     * ——已删除记录不占用渠道名，可重建同名渠道。
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('channels_provider_id_idx').on(t.providerId),
    // 渠道名唯一（仅约束在册记录——导入查重按 name，逻辑删除后名称释放可复用）
    uniqueIndex('channels_name_uq')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
    // 渠道在途敞口非负：释放路径带 >= 守卫的原子扣减，DB 兜底禁止穿透为负。
    // 注：不加 upstream_reserved <= upstream_budget 的 CHECK——管理端允许调低 budget，
    // 该场景由 reserveChannel 的守卫 UPDATE 拦截新预留，不构成结构不变量。
    check('channels_upstream_reserved_nonnegative_ck', sql`${t.upstreamReserved} >= 0`),
  ],
);
