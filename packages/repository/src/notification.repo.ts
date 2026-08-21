/**
 * notification_channels 仓储（通知渠道 CRUD + 出箱事件写入）。
 * 事件词表单一真相在服务层（NOTIFY_EVENTS）；本层只做行存取。
 * 出箱事件 dedupe_key 唯一索引幂等（onConflictDoNothing）。
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { notificationChannels, notifyOutbox } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

export interface NotificationChannelRow {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  events: string[];
  status: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimedNotificationRow {
  id: number;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  claimToken: string;
  deliveredChannelIds: number[];
}

const CHANNEL_COLUMNS = {
  id: notificationChannels.id,
  name: notificationChannels.name,
  type: notificationChannels.type,
  config: notificationChannels.config,
  events: notificationChannels.events,
  status: notificationChannels.status,
  createdAt: notificationChannels.createdAt,
  updatedAt: notificationChannels.updatedAt,
};

export class NotificationRepository {
  async listActive(c: RepoContext): Promise<NotificationChannelRow[]> {
    const rows = await c.db
      .select(CHANNEL_COLUMNS)
      .from(notificationChannels)
      .where(eq(notificationChannels.status, 0))
      .orderBy(asc(notificationChannels.id));
    return rows as NotificationChannelRow[];
  }

  async list(c: RepoContext): Promise<NotificationChannelRow[]> {
    const rows = await c.db.select(CHANNEL_COLUMNS).from(notificationChannels).orderBy(asc(notificationChannels.id));
    return rows as NotificationChannelRow[];
  }

  async findById(c: RepoContext, channelId: number): Promise<NotificationChannelRow | null> {
    const [row] = await c.db
      .select(CHANNEL_COLUMNS)
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId));
    return (row as NotificationChannelRow) ?? null;
  }

  async insert(
    c: RepoContext,
    input: { name: string; type: string; config: Record<string, unknown>; events: string[]; status?: number },
  ): Promise<NotificationChannelRow> {
    const [row] = await c.db
      .insert(notificationChannels)
      .values({
        name: input.name,
        type: input.type,
        config: input.config,
        events: input.events,
        status: input.status ?? 0,
      })
      .returning(CHANNEL_COLUMNS);
    if (!row) throw new Error('notification_channel.insert_failed');
    return row as NotificationChannelRow;
  }

  /** 部分更新（白名单字段）。0 行 = 不存在 */
  async patch(
    c: RepoContext,
    input: {
      channelId: number;
      patch: {
        name?: string;
        type?: string;
        config?: Record<string, unknown>;
        events?: string[];
        status?: number;
      };
    },
  ): Promise<NotificationChannelRow | null> {
    // type 不可改（config 校验口径与渠道类型绑定——服务层声明的不变量在此强制）
    const { type: _ignored, ...patch } = input.patch;
    const rows = await c.db
      .update(notificationChannels)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(notificationChannels.id, input.channelId))
      .returning(CHANNEL_COLUMNS);
    return (rows[0] as NotificationChannelRow) ?? null;
  }

  async remove(c: RepoContext, channelId: number): Promise<boolean> {
    const rows = await c.db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .returning({ id: notificationChannels.id });
    return rows.length > 0;
  }

  /** 出箱测试事件（幂等键 = test:{id}:{ts}——单发不重） */
  async insertOutboxEvent(
    c: RepoContext,
    input: { event: string; payload: Record<string, unknown>; dedupeKey: string },
  ): Promise<void> {
    await c.db.insert(notifyOutbox).values(input).onConflictDoNothing();
  }

  /** 原子批量认领：SKIP LOCKED 使多 Worker 不会同时执行同一外部副作用。 */
  async claimPending(
    c: RepoContext,
    input: { ownerId: string; limit: number; leaseMs: number; maxAttempts: number },
  ): Promise<ClaimedNotificationRow[]> {
    const result = await c.db.execute<{
      id: number;
      event: string;
      payload: Record<string, unknown>;
      attempts: number;
      claim_token: string;
      delivered_channel_ids: unknown;
    }>(sql`
      with candidates as (
        select id from notify_outbox
        where sent_at is null
          and attempts < ${input.maxAttempts}
          and next_attempt_at <= clock_timestamp()
          and (claim_until is null or claim_until <= clock_timestamp())
        order by id
        for update skip locked
        limit ${input.limit}
      )
      update notify_outbox o
      set claim_owner = ${input.ownerId},
          claim_token = gen_random_uuid(),
          claim_until = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')
      from candidates c2
      where o.id = c2.id
      returning o.id, o.event, o.payload, o.attempts, o.claim_token, o.delivered_channel_ids
    `);
    return result.rows.map((row) => ({
      id: row.id,
      event: row.event,
      payload: row.payload,
      attempts: row.attempts,
      claimToken: row.claim_token,
      deliveredChannelIds: Array.isArray(row.delivered_channel_ids)
        ? row.delivered_channel_ids.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id))
        : [],
    }));
  }

  /** 外部副作用成功后先持久化渠道进度；即使随后终态 CAS 因租约过期失败，重领也不会重发。 */
  async recordDeliveredChannels(
    c: RepoContext,
    input: { id: number; ownerId: string; claimToken: string; channelIds: number[] },
  ): Promise<boolean> {
    if (input.channelIds.length === 0) return true;
    const rows = await c.db
      .update(notifyOutbox)
      .set({
        deliveredChannelIds: sql`${notifyOutbox.deliveredChannelIds} || ${JSON.stringify(input.channelIds)}::jsonb`,
      })
      .where(
        and(
          eq(notifyOutbox.id, input.id),
          isNull(notifyOutbox.sentAt),
          eq(notifyOutbox.claimOwner, input.ownerId),
          eq(notifyOutbox.claimToken, input.claimToken),
          sql`${notifyOutbox.claimUntil} > clock_timestamp()`,
        ),
      )
      .returning({ id: notifyOutbox.id });
    return rows.length === 1;
  }

  /** 投递成功/无订阅渠道：仅当前未过期 claim 可以终态化。 */
  async completeClaim(
    c: RepoContext,
    input: { id: number; ownerId: string; claimToken: string },
  ): Promise<boolean> {
    const rows = await c.db
      .update(notifyOutbox)
      .set({
        sentAt: new Date(),
        attempts: sql`${notifyOutbox.attempts} + 1`,
        lastError: null,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
      })
      .where(
        and(
          eq(notifyOutbox.id, input.id),
          isNull(notifyOutbox.sentAt),
          eq(notifyOutbox.claimOwner, input.ownerId),
          eq(notifyOutbox.claimToken, input.claimToken),
          sql`${notifyOutbox.claimUntil} > clock_timestamp()`,
        ),
      )
      .returning({ id: notifyOutbox.id });
    return rows.length === 1;
  }

  /** 投递失败：增加尝试次数；未达上限释放 claim，达到上限则终态化。 */
  async failClaim(
    c: RepoContext,
    input: { id: number; ownerId: string; claimToken: string; maxAttempts: number; error: string },
  ): Promise<boolean> {
    const rows = await c.db
      .update(notifyOutbox)
      .set({
        attempts: sql`${notifyOutbox.attempts} + 1`,
        lastError: input.error.slice(0, 255),
        sentAt: sql`case when ${notifyOutbox.attempts} + 1 >= ${input.maxAttempts} then clock_timestamp() else null end`,
        nextAttemptAt: sql`case
          when ${notifyOutbox.attempts} + 1 >= ${input.maxAttempts} then clock_timestamp()
          else clock_timestamp() + (least(300000, 15000 * power(2, ${notifyOutbox.attempts})) * interval '1 millisecond')
        end`,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
      })
      .where(
        and(
          eq(notifyOutbox.id, input.id),
          isNull(notifyOutbox.sentAt),
          eq(notifyOutbox.claimOwner, input.ownerId),
          eq(notifyOutbox.claimToken, input.claimToken),
          sql`${notifyOutbox.claimUntil} > clock_timestamp()`,
        ),
      )
      .returning({ id: notifyOutbox.id });
    return rows.length === 1;
  }
}
