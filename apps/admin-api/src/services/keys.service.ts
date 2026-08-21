/**
 * API Key 管理面服务：全量列表（跨用户，q 命中用户邮箱/名——join 计数）
 * + 限额/状态补丁（不限属主；补丁后清网关鉴权缓存即时生效）。
 * 预览列外永不回 keyHash（明文在创建时一次性返回，管理面只见预览）。
 */
import type { Redis } from 'ioredis';
import { recordAudit } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { ListQueryParts } from '../http/list-query.js';

export const KEY_SORTS = ['id', 'name', 'status', 'lastUsedAt', 'createdAt'] as const;

export interface AdminKeysServiceDeps {
  db: Db;
  repos?: Repositories;
  redis: Redis | null;
}

export interface AdminKeysService {
  list(
    ctx: RunContext,
    input: { query: ListQueryParts; userId?: number; status?: number },
  ): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }>;
  patch(
    ctx: RunContext,
    input: {
      adminId: number;
      keyId: number;
      patch: {
        name?: string;
        rpmLimit?: number | null;
        tpmLimit?: number | null;
        dailySpendLimit?: string | null;
        status?: number;
      };
    },
  ): Promise<{ id: number }>;
}

export function createAdminKeysService(deps: AdminKeysServiceDeps): AdminKeysService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();

  return {
    async list(ctx, input) {
      const result = await repos.apiKey.listAdminKeys({ db, ...ctx }, {
        q: input.query.q,
        userId: input.userId,
        status: input.status,
        sortBy: input.query.sortBy as (typeof KEY_SORTS)[number],
        order: input.query.order,
        limit: input.query.limit,
        offset: input.query.offset,
      });
      return {
        rows: result.rows,
        total: result.total,
        page: input.query.page,
        pageSize: input.query.pageSize,
      };
    },

    async patch(ctx, input) {
      const updated = await repos.apiKey.adminPatchKey({ db, ...ctx }, {
        keyId: input.keyId,
        patch: input.patch,
      });
      if (!updated) throw new AppError(404, 'api_key_not_found', 'API key not found');
      if (deps.redis) {
      }
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'api_key.update_limit',
        targetType: 'api_key',
        targetId: input.keyId,
        detail: { patch: input.patch },
      });
      return { id: updated.id };
    },
  };
}
