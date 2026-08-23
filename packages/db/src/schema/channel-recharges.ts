import {
  bigint,
  bigserial,
  index,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { channels } from './channels.js';
import { admins } from './admins.js';

/**
 * channel_recharges — 渠道资金流水（入货 + 调账，审计留痕）。
 *
 * 语义：
 *   - recharge（入货）：管理员为渠道「进货」（往上游供应商账户充值），amount 恒为正；
 *     可附支付订单号（order_no）+ 支付凭证截图（voucher，本地磁盘 key，后续可切 OSS）。
 *   - adjust（调账）：修正入货/额度错误，amount 可正可负。
 *   - balance_after：本次变动后 channels.upstream_budget 的余额快照（对账追溯用）。
 * 只追加，不修改、不删除。
 */
export const channelRecharges = pgTable(
  'channel_recharges',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => channels.id),
    /** recharge（入货）/ adjust（调账） */
    type: varchar('type', { length: 16 }).notNull().default('recharge'),
    /** 有符号金额（元，numeric 全精度）；入货恒正，调账可正负 */
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    /** 变动后渠道余额（upstream_budget）快照（元） */
    balanceAfter: numeric('balance_after', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 支付订单号（入货时可选，追溯用） */
    orderNo: varchar('order_no', { length: 128 }),
    /** 支付凭证截图 key（本地磁盘文件名 / 未来 OSS object key） */
    voucher: varchar('voucher', { length: 128 }),
    remark: varchar('remark', { length: 255 }),
    /** 操作管理员（seed/导入可为 null） */
    adminId: bigint('admin_id', { mode: 'number' }).references(() => admins.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channel_recharges_channel_created_idx').on(t.channelId, t.createdAt)],
);
