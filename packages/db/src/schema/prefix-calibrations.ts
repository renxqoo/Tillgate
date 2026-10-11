import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * 收据校准记录（docs/calibrated-exposure-estimate.md §3.1）：
 * 结算成功时按 (user, mapping, prefix 哈希链) 记录实测 inputTokens，
 * 下一笔同前缀请求用它收缩预估（经济性消费面——B2/死信阈值永不消费，I0）。
 *
 * 写入守卫 C7（inference application/calibration.ts）：零钳制收据 +
 * seen ≥ prefixBytes/4 物理下限——低报计数器不得成链路锚点。
 * 写在结算事务末尾（wallet/channel 腿之后，避免跨表加锁序死锁向量）；
 * 保留策略 N 条由 worker 批后 best-effort 清理（不占资金事务锁）。
 *
 * FK 裁决（D10）：仅 user_id 带外键（用户删除随删，与 usage_logs 同族）；
 * mapping/channel 是历史事实，软删除不毁约，有意不带 FK。
 */
export const prefixCalibrations = pgTable(
  'prefix_calibrations',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mappingId: bigint('mapping_id', { mode: 'number' }).notNull(),
    /** 链式前缀哈希 chain(messages_len)（inference 哈希链，十六进制） */
    prefixHash: text('prefix_hash').notNull(),
    channelId: bigint('channel_id', { mode: 'number' }).notNull(),
    /** 上一笔收据实测 inputTokens（C7b 保证 ≥ prefixBytes/4） */
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    /** 上一笔 messages 数组长度（只追加匹配的切片锚点） */
    messagesLen: integer('messages_len').notNull(),
    /** 溯源请求 */
    requestId: uuid('request_id').notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.mappingId, t.prefixHash] }),
    // 读路径：top-N 现读按 (user, mapping) settled_at 倒序
    index('prefix_calibrations_recent_idx').on(t.userId, t.mappingId, t.settledAt.desc()),
  ],
);
