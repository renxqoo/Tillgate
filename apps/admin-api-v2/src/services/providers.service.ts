/**
 * 供应商管理服务：CRUD + 统一列表。协议词表单一真相 = @ai-gateway/ai 适配器注册表
 * （未注册协议 400——防「建得进去、请求时才炸」的静默错配）。
 * 重名交给 PG 唯一索引（23505 由 error-map 翻译 409）；删除 = 软退役。
 * 每次变更推进路由缓存版本（网关重建路由；Redis 缺席时网关 TTL 兜底）。
 */
import { SUPPORTED_PROTOCOLS } from '@ai-gateway/ai';
import type { Redis } from 'ioredis';
import { bumpRouteCache, recordAudit } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories, type ProviderRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { ListQueryParts } from '../http/list-query.js';

export const PROVIDER_SORTS = ['id', 'name', 'status', 'createdAt'] as const;

export interface ProvidersServiceDeps {
  db: Db;
  repos?: Repositories;
  redis: Redis | null;
}

export interface ProvidersService {
  list(ctx: RunContext, query: ListQueryParts): Promise<{ rows: ProviderRow[]; total: number; page: number; pageSize: number }>;
  create(
    ctx: RunContext,
    input: { adminId: number; name: string; protocol?: string; baseUrl: string; status?: number },
  ): Promise<ProviderRow>;
  update(
    ctx: RunContext,
    input: { adminId: number; providerId: number; patch: { name?: string; protocol?: string; baseUrl?: string; status?: number } },
  ): Promise<ProviderRow>;
  retire(ctx: RunContext, input: { adminId: number; providerId: number }): Promise<{ ok: true }>;
}

/** 协议词表校验（未注册协议 → 400——防「建得进去、请求时才炸」的静默错配） */
function assertProtocol(protocol: string | undefined): string | undefined {
  if (protocol === undefined) return undefined;
  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    throw new AppError(400, 'invalid_protocol', `不支持的协议（可选: ${SUPPORTED_PROTOCOLS.join(', ')}）`);
  }
  return protocol;
}

export function createProvidersService(deps: ProvidersServiceDeps): ProvidersService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();

  const bump = () => (deps.redis ? bumpRouteCache(deps.redis) : Promise.resolve());

  return {
    async list(ctx, query) {
      const result = await repos.provider.list({ db, ...ctx }, {
        q: query.q,
        sortBy: query.sortBy as (typeof PROVIDER_SORTS)[number],
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      });
      return { rows: result.rows, total: result.total, page: query.page, pageSize: query.pageSize };
    },

    async create(ctx, input) {
      const protocol = assertProtocol(input.protocol) ?? 'openai-compatible';
      const row = await repos.provider.insert({ db, ...ctx }, {
        name: input.name,
        protocol,
        baseUrl: input.baseUrl,
        status: input.status,
      });
      await bump();
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'provider.create',
        targetType: 'provider',
        targetId: row.id,
        detail: { name: row.name, protocol: row.protocol, baseUrl: row.baseUrl },
      });
      return row;
    },

    async update(ctx, input) {
      assertProtocol(input.patch.protocol);
      const row = await repos.provider.update({ db, ...ctx }, {
        providerId: input.providerId,
        patch: input.patch,
      });
      if (!row) throw new AppError(404, 'provider_not_found', '供应商不存在');
      await bump();
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'provider.update',
        targetType: 'provider',
        targetId: row.id,
        detail: { patch: input.patch },
      });
      return row;
    },

    async retire(ctx, input) {
      const ok = await repos.provider.retire({ db, ...ctx }, { providerId: input.providerId });
      if (!ok) throw new AppError(404, 'provider_not_found', '供应商不存在');
      await bump();
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'provider.retire',
        targetType: 'provider',
        targetId: input.providerId,
      });
      return { ok: true as const };
    },
  };
}
