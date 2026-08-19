/**
 * notification_channels 仓储（通知渠道 CRUD + 出箱事件写入）。
 * 事件词表单一真相在服务层（NOTIFY_EVENTS）；本层只做行存取。
 * 出箱事件 dedupe_key 唯一索引幂等（onConflictDoNothing）。
 */
import { asc, eq } from 'drizzle-orm';
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
}
