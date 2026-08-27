/**
 * 通知渠道路由契约。
 * webhook 需 url+secret;email 需 recipients（refine 互斥;events 词表封闭）。
 * 事件词表单一真相 = notifications domain NOTIFY_EVENTS（此处 import,不复制）。
 */
import * as z from 'zod';
import { NOTIFY_EVENTS } from '@tillgate/notifications';

const configSchema = z
  .object({
    url: z.string().url().max(255).optional(),
    secret: z.string().min(16).max(255).optional(),
    recipients: z.array(z.string().email().max(255)).max(20).optional(),
  })
  .refine((cfg) => (cfg.url && cfg.secret) || (cfg.recipients && cfg.recipients.length > 0), {
    message: 'webhook requires url+secret; email requires recipients',
  });

const channelSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(['webhook', 'email']),
  config: configSchema,
  events: z.array(z.enum(NOTIFY_EVENTS)).min(1),
  status: z.number().int().min(0).max(1).optional(),
});

export const notificationsContracts = {
  create: channelSchema,
  /** 类型不可改（config 口径与类型绑定,以 z.never() 拒绝） */
  update: channelSchema.partial().extend({ type: z.never().optional() }),
};
