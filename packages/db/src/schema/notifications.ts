import {
  check,
  index,
  jsonb,
  pgTable,
  bigserial,
  varchar,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * notification_channels — 告警通知渠道（data-model.md §3.18）
 * type: webhook（config: {url, secret}，POST + HMAC-SHA256 签名头）/ email（config: {recipients: string[]}）
 * events: 订阅的事件类型列表（NOTIFY_EVENTS 词表，worker 投递时过滤）。
 */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 64 }).notNull(),
    type: varchar('type', { length: 8 }).notNull(),
    /** webhook: {url: string, secret: string} / email: {recipients: string[]} */
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    /** 订阅事件（NOTIFY_EVENTS 子集；投递前按此过滤） */
    events: jsonb('events').$type<string[]>().notNull(),
    /** 0 启用 / 1 停用 */
    status: smallint('status').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_channels_name_uq').on(t.name),
    check('notification_channels_type_ck', sql`${t.type} in ('webhook','email')`),
    check('notification_channels_status_ck', sql`${t.status} in (0, 1)`),
  ],
);

/**
 * notify_outbox — 事务性发件箱（data-model.md §3.19）
 * 与业务状态变更同事务写入（渠道禁用/对账差异/死单/余额预警），worker 轮询投递——
 * 不搞事后扫描，事件即事实。dedupe_key 唯一防重复入箱（如余额预警按 用户×日）。
 * 投递失败退避重试，attempts 达上限后标 failed（sent_at 置时间 + last_error）。
 */
export const notifyOutbox = pgTable(
  'notify_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 事件类型（NOTIFY_EVENTS 词表） */
    event: varchar('event', { length: 32 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** 入箱幂等键（业务自然键，如 balance-low:{userId}:{yyyyMMdd}） */
    dedupeKey: varchar('dedupe_key', { length: 128 }).notNull(),
    attempts: smallint('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 255 }),
    /** 已成功投递的渠道 id；部分失败重试时跳过，避免重复轰炸已成功渠道。 */
    deliveredChannelIds: jsonb('delivered_channel_ids').$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    /** 失败退避截止；避免同一轮循环立即重试三次并饿死后续事件。 */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** 多副本消费 fencing：三列同时为空或同时非空；租约过期后可安全重领。 */
    claimOwner: varchar('claim_owner', { length: 128 }),
    claimToken: uuid('claim_token'),
    claimUntil: timestamp('claim_until', { withTimezone: true }),
    /** NULL = 待投递；非 NULL = 已投递或已放弃（时间即终态时间） */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notify_outbox_dedupe_uq').on(t.dedupeKey),
    // 待投递扫描队列（worker runNotifyDispatch 轮询 WHERE sent_at IS NULL ORDER BY id）
    index('notify_outbox_pending_idx')
      .on(t.nextAttemptAt, t.claimUntil, t.id)
      .where(sql`sent_at is null`),
    check('notify_outbox_delivered_channels_ck', sql`jsonb_typeof(${t.deliveredChannelIds}) = 'array'`),
    check(
      'notify_outbox_claim_ck',
      sql`(${t.claimOwner} is null and ${t.claimToken} is null and ${t.claimUntil} is null)
          or (${t.sentAt} is null and ${t.claimOwner} is not null and ${t.claimToken} is not null and ${t.claimUntil} is not null)`,
    ),
  ],
);
