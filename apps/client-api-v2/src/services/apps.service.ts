/**
 * Apps 凭证管理服务（企业 Agent）：创建（client_secret 仅此一次下发）/ 列表 /
 * 禁用 / 轮换密钥。计费来源订阅归属守卫与 Key 同口径（W1：绑他人订阅 404）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type AppRow, type Repositories } from '@ai-gateway/repository';
import { generateClientId, generateClientSecret, sha256Hex } from '@ai-gateway/http';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import { recordAudit } from '@ai-gateway/http';

const asUser = (ctx: RunContext, userId: number): RunContext => ({
  ...ctx,
  actor: { kind: 'user', id: userId },
});

export interface AppsService {
  create(
    ctx: RunContext,
    userId: number,
    input: {
      name: string;
      description?: string | null;
      subscriptionId?: number | null;
      scope?: { models?: string[]; rpm?: number; tpm?: number } | null;
    },
  ): Promise<AppRow & { clientSecret: string }>;
  list(
    ctx: RunContext,
    userId: number,
    input: { page: number; limit: number },
  ): Promise<{ rows: AppRow[]; total: number }>;
  disable(ctx: RunContext, userId: number, appId: number): Promise<void>;
  rotateSecret(
    ctx: RunContext,
    userId: number,
    appId: number,
  ): Promise<{ id: number; clientSecret: string }>;
}

export function createAppsService(deps: { db: Db; repos?: Repositories; clock?: () => Date; maxAppsPerUser?: number }): AppsService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const clock = deps.clock ?? (() => new Date());

  return {
    async create(ctx, userId, input) {
      const runCtx = asUser(ctx, userId);
      // 计费来源归属守卫（W1）：与 Key 同口径
      let subscriptionId = input.subscriptionId ?? null;
      if (subscriptionId != null) {
        const usable = await repos.org.findUsableSubscription(
          { db, ...runCtx },
          { userId, subscriptionId, now: clock() },
        );
        if (!usable) {
          throw new AppError(404, 'subscription_not_usable', '订阅不存在、已到期或无权使用');
        }
      }
      const clientSecret = generateClientSecret();
      const row = await db.transaction(async (tx) => {
        // App 配额闸（v1 对位：无闸可无限建 App）——advisory lock 防双击竞态
        if (deps.maxAppsPerUser != null) {
          const c = { db: tx, ...runCtx };
          await repos.apps.advisoryLockAppQuota(c, userId);
          const active = await repos.apps.countActiveByUser(c, userId);
          if (active >= deps.maxAppsPerUser) {
            throw new AppError(409, 'app_limit_reached', `在用 App 数已达上限 ${deps.maxAppsPerUser}`);
          }
        }
        return repos.apps.insertApp({ db: tx, ...runCtx }, {
          appId: randomUUID().replace(/-/g, '').slice(0, 32),
          userId,
          clientId: generateClientId(),
          clientSecretHash: sha256Hex(clientSecret),
          name: input.name,
          description: input.description ?? null,
          subscriptionId,
          scope: input.scope ?? null,
        });
      });
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'app.create',
        targetType: 'app',
        targetId: row.id,
        detail: { name: input.name },
      }).catch(() => undefined);
      // 明文唯一一次出库
      return { ...row, clientSecret };
    },

    list(ctx, userId, input) {
      const runCtx = asUser(ctx, userId);
      return repos.apps.listByUser({ db, ...runCtx }, {
        userId,
        limit: input.limit,
        offset: (input.page - 1) * input.limit,
      });
    },

    async disable(ctx, userId, appId) {
      const runCtx = asUser(ctx, userId);
      const owned = await repos.apps.findOwned({ db, ...runCtx }, { userId, appId });
      if (!owned) throw new AppError(404, 'app_not_found', 'App 不存在');
      if (owned.status !== 0) throw new AppError(409, 'app_already_disabled', 'App 已禁用');
      const disabled = await db.transaction(async (tx) =>
        repos.apps.disableApp({ db: tx, ...runCtx }, { userId, appId }),
      );
      if (!disabled) throw new AppError(409, 'app_already_disabled', 'App 已禁用');
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'app.disable',
        targetType: 'app',
        targetId: appId,
      }).catch(() => undefined);
    },

    async rotateSecret(ctx, userId, appId) {
      const runCtx = asUser(ctx, userId);
      const owned = await repos.apps.findOwned({ db, ...runCtx }, { userId, appId });
      if (!owned) throw new AppError(404, 'app_not_found', 'App 不存在');
      const clientSecret = generateClientSecret();
      const rotated = await db.transaction(async (tx) =>
        repos.apps.rotateSecret({ db: tx, ...runCtx }, {
          userId,
          appId,
          clientSecretHash: sha256Hex(clientSecret),
          rotatedAt: clock(),
        }),
      );
      if (!rotated) throw new AppError(404, 'app_not_found', 'App 不存在');
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'app.rotate_secret',
        targetType: 'app',
        targetId: appId,
      }).catch(() => undefined);
      return { id: appId, clientSecret };
    },
  };
}
