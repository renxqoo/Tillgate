import {
  check,
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
  numeric,
  bigint,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { jsonb } from './jsonb.js';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { apiKeys } from './api-keys.js';
import { modelMappings } from './model-mappings.js';
import { channels } from './channels.js';
import { billingRequests } from './billing-requests.js';

/**
 * generation_tasks — 异步生成任务（视频/音乐）
 *
 * 资金单一真相在 billing_requests（两阶段：提交=authorize 预留 → 完成=实扣 /
 * 失败/超时=released 释放）；本表只承载任务生命周期与产物，终态时由 worker
 * 经 billing signal 驱动账本转移（succeeded 带收据 / failed 释放）。顺序：
 * succeeded 先 signal 后 CAS 终态（信号=实扣是权威动作，
 * 失败保留任务行重试——防漏收费）；failed/expired 先 CAS 终态后 signal
 * （释放路径相反，信号失败由 recover 兜底）。
 *
 * 状态机：queued（已提交，音乐=待 worker 执行）→ running →
 *          succeeded（result 必填）| failed / expired（fail_reason 必填）。
 * music 为同步阻塞型上游调用，由 worker 代执行：无 upstream_task_id。
 */
export const generationTasks = pgTable(
  'generation_tasks',
  {
    /** 对外任务 ID（GET /v1/videos/{id} 查询键） */
    id: uuid('id').primaryKey().defaultRandom(),
    /** 关联账单（billing_requests.request_id，预留与结算的事实源） */
    requestId: uuid('request_id')
      .notNull()
      .references(() => billingRequests.requestId, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    apiKeyId: bigint('api_key_id', { mode: 'number' }).references(() => apiKeys.id),
    mappingId: bigint('mapping_id', { mode: 'number' })
      .notNull()
      .references(() => modelMappings.id),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => channels.id),
    /** 上游任务号（MiniMax video_generation task_id；music 同步调用为 NULL） */
    upstreamTaskId: varchar('upstream_task_id', { length: 128 }),
    /**
     * 出站上游模型名快照（提交时从绑定行物化；worker 代执行用它构造请求）。
     * 与 params 同为提交时快照——在途任务不随绑定改名漂移。
     */
    upstreamModel: varchar('upstream_model', { length: 128 }).notNull(),
    /** video / music */
    kind: varchar('kind', { length: 16 }).notNull(),
    /** queued / running / succeeded / failed / expired */
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    /** 提交参数快照（prompt/duration/ratio/帧图引用等，kind 各自 schema 校验后落） */
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    /** 收据模板（网关提交时构建，除 usage.units 外全部字段；worker 终态填 units 即成收据） */
    receiptTemplate: jsonb('receipt_template').$type<Record<string, unknown>>().notNull(),
    /** 按秒计费的时长快照（pricingUnit=second 时=duration；按次为 1） */
    unitsSnapshot: numeric('units_snapshot', { precision: 38, scale: 18 }),
    /** 终态产物（video: {videoUrl,width,height}；music: {audioUrl}） */
    result: jsonb('result').$type<Record<string, unknown>>(),
    failReason: varchar('fail_reason', { length: 512 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 超时上界（提交时间 + 任务 TTL）：worker 超时扫描的权威时间源 */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    // 轮询扫描队列（worker 只取未终态行）
    index('generation_tasks_status_created_idx').on(t.status, t.createdAt),
    index('generation_tasks_user_created_idx').on(t.userId, t.createdAt.desc()),
    // 同渠道上游任务号唯一（防同 task_id 双落；music 无上游号，PG 唯一索引允许多 NULL）
    uniqueIndex('generation_tasks_channel_upstream_uq').on(t.channelId, t.upstreamTaskId),
    check('generation_tasks_kind_ck', sql`${t.kind} in ('video', 'music')`),
    check(
      'generation_tasks_status_ck',
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'expired')`,
    ),
    // 终态一致性：成功必有产物，失败/超时必有原因（任务迁移与产物/原因同 UPDATE 写入）
    check(
      'generation_tasks_terminal_state_ck',
      sql`(
        ${t.status} = 'succeeded' and ${t.result} is not null
      ) or (
        ${t.status} in ('failed', 'expired') and ${t.failReason} is not null
      ) or ${t.status} in ('queued', 'running')`,
    ),
  ],
);
