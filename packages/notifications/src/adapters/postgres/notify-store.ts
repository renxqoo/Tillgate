/**
 * NotifyStore 的 PostgreSQL 实现:
 * 认领 CTE(FOR UPDATE SKIP LOCKED)、三列 CAS fencing、jsonb 进度追加、退避表达式
 * ——真实行为等价由 __test__/postgres.real.test.ts 锁定。
 * 行类型不泄 db 形状(type 经词表收窄,delivered_channel_ids 过滤安全整数)。
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { notificationChannels, notifyOutbox } from '@tillgate/db';
import type {
  ChannelInsertInput,
  ChannelPatchInput,
  ClaimedNotification,
  ClaimFencing,
  ClaimInput,
  FailClaimInput,
  NotifyStore,
} from '../../ports/notify-store';
import type { NotificationChannel } from '../../domain/channel';
import type { ChannelType } from '../../domain/channel';

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

type ChannelRow = Omit<NotificationChannel, 'type'> & { type: string };

function toChannel(row: ChannelRow): NotificationChannel {
  return { ...row, type: row.type as ChannelType, events: [...row.events] };
}

export const postgresNotifyStore: NotifyStore = {
  async listChannels(db, filter) {
    const rows = filter.activeOnly
      ? await db
          .select(CHANNEL_COLUMNS)
          .from(notificationChannels)
          .where(eq(notificationChannels.status, 0))
          .orderBy(asc(notificationChannels.id))
      : await db
          .select(CHANNEL_COLUMNS)
          .from(notificationChannels)
          .orderBy(asc(notificationChannels.id));
    return rows.map((row) => toChannel(row as ChannelRow));
  },

  async findChannel(db, channelId) {
    const [row] = await db
      .select(CHANNEL_COLUMNS)
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId));
    return row ? toChannel(row as ChannelRow) : null;
  },

  async insertChannel(db, input: ChannelInsertInput) {
    const [row] = await db
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
    return toChannel(row as ChannelRow);
  },

  async patchChannel(db, input: { channelId: number; patch: ChannelPatchInput }) {
    // 白名单落库(type 永不可改——config 校验口径与渠道类型绑定)
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.patch.name !== undefined) set.name = input.patch.name;
    if (input.patch.config !== undefined) set.config = input.patch.config;
    if (input.patch.events !== undefined) set.events = input.patch.events;
    if (input.patch.status !== undefined) set.status = input.patch.status;
    const rows = await db
      .update(notificationChannels)
      .set(set)
      .where(eq(notificationChannels.id, input.channelId))
      .returning(CHANNEL_COLUMNS);
    return rows[0] ? toChannel(rows[0] as ChannelRow) : null;
  },

  async removeChannel(db, channelId) {
    const rows = await db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .returning({ id: notificationChannels.id });
    return rows.length > 0;
  },

  async insertOutboxEvent(db, input) {
    await db.insert(notifyOutbox).values(input).onConflictDoNothing();
  },

  async claimPending(db, input: ClaimInput): Promise<ClaimedNotification[]> {
    const result = await db.execute<{
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
    return result.map((row) => ({
      // node-postgres 把 bigint 以字符串返回(bigserial mode:'number' 只作用于
      // 查询构建器映射)——此处显式归一为 port 契约的 number
      id: Number(row.id),
      event: row.event,
      payload: row.payload,
      attempts: row.attempts,
      claimToken: row.claim_token,
      deliveredChannelIds: Array.isArray(row.delivered_channel_ids)
        ? row.delivered_channel_ids.filter(
            (id): id is number => typeof id === 'number' && Number.isSafeInteger(id),
          )
        : [],
    }));
  },

  async recordDeliveredChannels(db, input: ClaimFencing & { channelIds: number[] }) {
    if (input.channelIds.length === 0) return true;
    const rows = await db
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
  },

  async completeClaim(db, input: ClaimFencing) {
    const rows = await db
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
  },

  async failClaim(db, input: FailClaimInput) {
    const rows = await db
      .update(notifyOutbox)
      .set({
        attempts: sql`${notifyOutbox.attempts} + 1`,
        lastError: input.error.slice(0, 255),
        sentAt: sql`case when ${notifyOutbox.attempts} + 1 >= ${input.maxAttempts} then clock_timestamp() else null end`,
        nextAttemptAt: sql`case
          when ${notifyOutbox.attempts} + 1 >= ${input.maxAttempts} then clock_timestamp()
          else clock_timestamp() + (${input.retryDelayMs} * interval '1 millisecond')
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
  },
};
