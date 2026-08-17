import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { intParam, jsonBody } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { Db } from '@ai-gateway/db';
import { notificationChannels, notifyOutbox } from '@ai-gateway/db/schema';

/**
 * 告警通知渠道管理（notification_channels CRUD + 测试事件入箱）。
 * 投递由 worker runNotifyDispatch 承担（webhook HMAC / 邮件）；管理面只管配置。
 * NOTIFY_EVENTS 词表单一真相在 apps/worker tasks/notify-referral.ts——API 层复制词表
 * 校验（跨包共享 schema 常量会引入 worker→admin 依赖方向反转，词表同步由测试锁定）。
 */

const NOTIFY_EVENTS = ['channel_disabled', 'reconcile_discrepancy', 'billing_dead', 'balance_low'] as const;

const channelSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: z.enum(['webhook', 'email']),
    config: z
      .object({
        url: z.string().url().max(255).optional(),
        secret: z.string().min(16).max(255).optional(),
        recipients: z.array(z.string().email().max(255)).max(20).optional(),
      })
      .refine((v) => (v.url && v.secret) || (v.recipients && v.recipients.length > 0), {
        message: 'webhook 需 url+secret；email 需 recipients',
      }),
    events: z.array(z.enum(NOTIFY_EVENTS)).min(1),
    status: z.number().int().min(0).max(1).optional(),
  })
  .passthrough();

export function notificationAdminRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/', async (c) => {
      const rows = await db.select().from(notificationChannels).orderBy(notificationChannels.id);
      return c.json({ list: rows });
    })
    .post('/', jsonBody(channelSchema), async (c) => {
      const body = c.req.valid('json');
      try {
        const [row] = await db
          .insert(notificationChannels)
          .values({
            name: body.name,
            type: body.type,
            config: body.config,
            events: body.events,
            status: body.status ?? 0,
          })
          .returning();
        return c.json({ ok: true, channel: row });
      } catch {
        return c.json({ error: { code: 'conflict', message: '同名渠道已存在' } }, 409);
      }
    })
    .patch('/:id', jsonBody(channelSchema.partial()), async (c) => {
      const body = c.req.valid('json');
      const updated = await db
        .update(notificationChannels)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.config !== undefined ? { config: body.config } : {}),
          ...(body.events !== undefined ? { events: body.events } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(notificationChannels.id, intParam(c, 'id')))
        .returning({ id: notificationChannels.id });
      if (updated.length === 0) {
        return c.json({ error: { code: 'not_found', message: '渠道不存在' } }, 404);
      }
      return c.json({ ok: true });
    })
    .delete('/:id', async (c) => {
      await db.delete(notificationChannels).where(eq(notificationChannels.id, intParam(c, 'id')));
      return c.json({ ok: true });
    })
    .post('/:id/test', async (c) => {
      const id = intParam(c, 'id');
      const ch = await db.query.notificationChannels.findFirst({ where: eq(notificationChannels.id, id) });
      if (!ch) return c.json({ error: { code: 'not_found', message: '渠道不存在' } }, 404);
      await db
        .insert(notifyOutbox)
        .values({
          event: ch.events[0] ?? 'channel_disabled',
          payload: { test: true, channel: ch.name },
          dedupeKey: `test:${ch.id}:${Date.now()}`,
        })
        .onConflictDoNothing();
      return c.json({ ok: true });
    });
}
