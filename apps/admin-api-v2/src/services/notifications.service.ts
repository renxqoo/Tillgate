/**
 * 通知渠道服务：CRUD + 测试事件入箱。
 * 事件词表单一真相（worker 投递侧按同一词表过滤）：
 * channel_disabled / reconcile_discrepancy / billing_dead / balance_low。
 * webhook 渠道需 url+secret；email 渠道需 recipients（服务层校验，仓储白名单落库）。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories, type NotificationChannelRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';

export const NOTIFY_EVENTS = ['channel_disabled', 'reconcile_discrepancy', 'billing_dead', 'balance_low'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export interface NotificationChannelInput {
  name: string;
  type: 'webhook' | 'email';
  config: { url?: string; secret?: string; recipients?: string[] };
  events: NotifyEvent[];
  status?: number;
}

export interface NotificationsServiceDeps {
  db: Db;
  repos?: Repositories;
}

export interface NotificationsService {
  list(ctx: RunContext): Promise<{ list: NotificationChannelRow[] }>;
  create(ctx: RunContext, input: NotificationChannelInput): Promise<NotificationChannelRow>;
  patch(
    ctx: RunContext,
    input: { channelId: number; patch: Partial<NotificationChannelInput> },
  ): Promise<NotificationChannelRow>;
  remove(ctx: RunContext, channelId: number): Promise<{ ok: true }>;
  /** 测试事件入箱（实际投递由 worker runNotifyDispatch 轮询） */
  test(ctx: RunContext, channelId: number): Promise<{ ok: true }>;
}

/** 密钥掩码（保留尾 4 位——管理员可辨认、不可复用） */
function maskSecret(secret: string): string {
  if (!secret) return '****';
  return `****${secret.slice(-4)}`;
}

function assertChannelInput(input: { type?: string; config?: { url?: string; secret?: string; recipients?: string[] }; events?: string[] }): void {
  if (input.type !== undefined && input.type !== 'webhook' && input.type !== 'email') {
    throw new AppError(400, 'validation_error', '渠道类型必须是 webhook 或 email');
  }
  if (input.events !== undefined) {
    if (input.events.length === 0) throw new AppError(400, 'validation_error', '至少订阅一个事件');
    for (const event of input.events) {
      if (!(NOTIFY_EVENTS as readonly string[]).includes(event)) {
        throw new AppError(400, 'validation_error', `未知事件：${event}`);
      }
    }
  }
  if (input.config !== undefined && input.type !== undefined) {
    if (input.type === 'webhook' && !(input.config.url && input.config.secret)) {
      throw new AppError(400, 'validation_error', 'webhook 渠道需 url + secret');
    }
    if (input.type === 'email' && !(input.config.recipients && input.config.recipients.length > 0)) {
      throw new AppError(400, 'validation_error', 'email 渠道需 recipients');
    }
  }
}

export function createNotificationsService(deps: NotificationsServiceDeps): NotificationsService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();

  return {
    async list(ctx) {
      const rows = await repos.notification.list({ db, ...ctx });
      // webhook 签名密钥不进列表响应（与渠道 apiKey 同口径：存储侧加密属另一工作项，
      // 读取侧先收口——任何管理会话/库转储都不该直接拿到可伪造通知的 secret）
      return {
        list: rows.map((row) => ({
          ...row,
          config: row.config && typeof row.config === 'object' && 'secret' in (row.config as Record<string, unknown>)
            ? { ...(row.config as Record<string, unknown>), secret: maskSecret(String((row.config as Record<string, unknown>).secret)) }
            : row.config,
        })),
      };
    },

    async create(ctx, input) {
      assertChannelInput(input);
      try {
        return await repos.notification.insert({ db, ...ctx }, {
          name: input.name,
          type: input.type,
          config: input.config as Record<string, unknown>,
          events: input.events,
          status: input.status,
        });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new AppError(409, 'conflict', '同名渠道已存在');
        }
        throw e;
      }
    },

    async patch(ctx, input) {
      // 类型不可改（config 校验口径与渠道类型绑定）——词表校验按合并后口径
      assertChannelInput(input.patch);
      const row = await repos.notification.patch({ db, ...ctx }, {
        channelId: input.channelId,
        patch: {
          ...input.patch,
          ...(input.patch.config !== undefined ? { config: input.patch.config as Record<string, unknown> } : {}),
        },
      });
      if (!row) throw new AppError(404, 'not_found', '渠道不存在');
      if (row.config && typeof row.config === 'object' && 'secret' in (row.config as Record<string, unknown>)) {
        return {
          ...row,
          config: {
            ...(row.config as Record<string, unknown>),
            secret: maskSecret(String((row.config as Record<string, unknown>).secret)),
          },
        };
      }
      return row;
    },

    async remove(ctx, channelId) {
      const removed = await repos.notification.remove({ db, ...ctx }, channelId);
      if (!removed) throw new AppError(404, 'not_found', '渠道不存在');
      return { ok: true as const };
    },

    async test(ctx, channelId) {
      const channel = await repos.notification.findById({ db, ...ctx }, channelId);
      if (!channel) throw new AppError(404, 'not_found', '渠道不存在');
      await repos.notification.insertOutboxEvent({ db, ...ctx }, {
        event: channel.events[0] ?? 'channel_disabled',
        payload: { test: true, channel: channel.name },
        dedupeKey: `test:${channelId}:${Date.now()}`,
      });
      return { ok: true as const };
    },
  };
}
