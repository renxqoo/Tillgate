/**
 * 渠道管理服务：CRUD + 批量导入 + 连通性探针。
 *
 * 密钥生命周期：明文只在加密前/解密后的内存存在——
 *   - 创建/换 Key：core.encrypt（单 key 单格式 enc:v1）落库，返回体永不带密文
 *   - 换 Key 同时复位运行态（status=0 / failCount=0 / cooldownUntil=null——
 *     「换 Key = 修死凭据」的运维语义）
 *   - 探针解密后仅回 keyPreview（首4+****+尾4）
 * 批量导入：best-effort（单条失败不中断；全败 = 400）；供应商按名精确解析。
 * 列表富化：绑定模型 + 上游累计消耗（仅当前页，聚合下推 SQL）。
 */
import type { Ai } from '@ai-gateway/ai';
import { encrypt, decrypt } from '@ai-gateway/core';
import type { Redis } from 'ioredis';
import { maskUpstreamKey, recordAudit} from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { ListQueryParts } from '../http/list-query.js';

export const CHANNEL_SORTS = ['id', 'name', 'status', 'priority', 'createdAt'] as const;

export interface ChannelsServiceDeps {
  db: Db;
  repos?: Repositories;
  redis: Redis | null;
  /** 渠道密钥加密密钥（单 key 单格式 enc:v1） */
  encryptionKey: string;
  /** 批量导入单次条目上限 */
  importMax: number;
  /** 探针 Ai 工厂（每次新建——内存态隔离） */
  createTester: () => Ai;
}

export interface ChannelCreateInput {
  providerId: number;
  name: string;
  apiKey: string;
  baseUrlOverride?: string | null;
  models?: string[] | null;
  weight?: number;
  priority?: number;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

export interface ChannelUpdateInput {
  name?: string;
  apiKey?: string;
  baseUrlOverride?: string | null;
  models?: string[] | null;
  weight?: number;
  priority?: number;
  status?: number;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  upstreamThreshold?: string | null;
}

export interface ChannelImportItem {
  provider: string;
  name: string;
  apiKey: string;
  models?: string[];
  weight?: number;
  priority?: number;
}

export interface ChannelsService {
  list(
    ctx: RunContext,
    query: ListQueryParts,
  ): Promise<{
    rows: Array<{
      id: number;
      name: string;
      providerId: number;
      providerName: string;
      baseUrlOverride: string | null;
      models: string[] | null;
      weight: number;
      priority: number;
      status: number;
      failCount: number;
      rpmLimit: number | null;
      tpmLimit: number | null;
      upstreamBudget: string;
      upstreamThreshold: string | null;
      createdAt: Date;
      boundModels: string[];
      upstreamConsumed: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }>;
  create(ctx: RunContext, input: { adminId: number } & ChannelCreateInput): Promise<{ id: number; name: string; providerId: number }>;
  update(
    ctx: RunContext,
    input: { adminId: number; channelId: number; patch: ChannelUpdateInput },
  ): Promise<{ id: number; name: string; status: number; failCount: number }>;
  retire(ctx: RunContext, input: { adminId: number; channelId: number }): Promise<{ ok: true }>;
  import(
    ctx: RunContext,
    input: { adminId: number; channels: ChannelImportItem[] },
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    details: Array<{ index: number; ok: boolean; channelId?: number; name?: string; error?: string }>;
  }>;
  /** 连通性探针（真实解密 + 独立 Ai 实例）；回显仅 keyPreview（坏密文时无预览） */
  probe(
    ctx: RunContext,
    channelId: number,
  ): Promise<{ ok: boolean; durationMs: number; error?: { code: string; message: string }; keyPreview?: string }>;
}

export function createChannelsService(deps: ChannelsServiceDeps): ChannelsService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();


  return {
    async list(ctx, query) {
      const result = await repos.channel.listChannels({ db, ...ctx }, {
        q: query.q,
        sortBy: query.sortBy as (typeof CHANNEL_SORTS)[number],
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      });
      const pageIds = result.rows.map((row) => row.id);
      const [bindings, consumed] = await Promise.all([
        repos.channel.listBoundModelsByChannelIds({ db, ...ctx }, pageIds),
        repos.channel.sumUpstreamConsumedByChannelIds({ db, ...ctx }, pageIds),
      ]);
      const modelsByChannel = new Map<number, string[]>();
      for (const b of bindings) {
        const list = modelsByChannel.get(b.channelId) ?? [];
        list.push(b.externalName);
        modelsByChannel.set(b.channelId, list);
      }
      return {
        rows: result.rows.map((row) => ({
          ...row,
          boundModels: modelsByChannel.get(row.id) ?? [],
          upstreamConsumed: consumed.get(row.id) ?? '0',
        })),
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async create(ctx, input) {
      const apiKeyEnc = encrypt(input.apiKey, deps.encryptionKey);
      const row = await db.transaction(async (tx) =>
        repos.channel.insertChannel({ db: tx, ...ctx }, {
          providerId: input.providerId,
          name: input.name,
          apiKeyEnc,
          baseUrlOverride: input.baseUrlOverride ?? null,
          models: input.models ?? null,
          weight: input.weight,
          priority: input.priority,
          rpmLimit: input.rpmLimit ?? null,
          tpmLimit: input.tpmLimit ?? null,
        }),
      );
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'channel.create',
        targetType: 'channel',
        targetId: row.id,
        detail: { name: row.name, providerId: row.providerId },
      });
      return row;
    },

    async update(ctx, input) {
      // 换 Key：重加密 + 复位运行态（死凭据 status=4 / 熔断 status=3 一并清除）
      const { apiKey, ...rest } = input.patch;
      const patch: Omit<ChannelUpdateInput, 'apiKey'> & {
        apiKeyEnc?: string;
        status?: number;
        failCount?: number;
        cooldownUntil?: Date | null;
      } = { ...rest };
      const keyChanged = apiKey !== undefined;
      if (keyChanged) {
        patch.apiKeyEnc = encrypt(apiKey, deps.encryptionKey);
      }
      const row = await db.transaction(async (tx) => {
        if (keyChanged) {
          Object.assign(patch, { status: 0, failCount: 0, cooldownUntil: null });
        }
        return repos.channel.updateChannel({ db: tx, ...ctx }, { channelId: input.channelId, patch });
      });
      if (!row) throw new AppError(404, 'channel_not_found', '渠道不存在');
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'channel.update',
        targetType: 'channel',
        targetId: row.id,
        detail: { keyChanged, ...(input.patch.name !== undefined ? { name: input.patch.name } : {}) },
      });
      return row;
    },

    async retire(ctx, input) {
      const ok = await repos.channel.retireChannel({ db, ...ctx }, { channelId: input.channelId });
      if (!ok) throw new AppError(404, 'channel_not_found', '渠道不存在');
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'channel.retire',
        targetType: 'channel',
        targetId: input.channelId,
      });
      return { ok: true as const };
    },

    async import(ctx, input) {
      if (input.channels.length === 0) {
        throw new AppError(400, 'validation_error', '导入列表不能为空');
      }
      if (input.channels.length > deps.importMax) {
        throw new AppError(400, 'validation_error', `单次导入上限 ${deps.importMax} 条`);
      }
      const details: Awaited<ReturnType<ChannelsService['import']>>['details'] = [];
      let success = 0;

      for (const [index, item] of input.channels.entries()) {
        try {
          // 供应商按名精确解析（miss = 该条失败，不中断批次）
          const provider = await repos.provider.findByName({ db, ...ctx }, item.provider);
          if (!provider) {
            throw new AppError(400, 'provider_not_found', `供应商「${item.provider}」不存在，请先创建`);
          }
          const existing = await repos.channel.findChannelByName({ db, ...ctx }, item.name);
          if (existing) {
            throw new AppError(409, 'conflict', '同名渠道已存在');
          }
          const created = await db.transaction(async (tx) => {
            const channel = await repos.channel.insertChannel({ db: tx, ...ctx }, {
              providerId: provider.id,
              name: item.name,
              apiKeyEnc: encrypt(item.apiKey, deps.encryptionKey),
              weight: item.weight ?? 1,
              priority: item.priority ?? 0,
            });
            // 目录条目按外部名绑定（缺映射跳过——目录名未建映射不算错）
            for (const modelName of item.models ?? []) {
              const mapping = await repos.modelMapping.findByExternalName({ db: tx, ...ctx }, modelName);
              if (mapping) {
                await repos.modelMapping.ensureModelChannelBinding({ db: tx, ...ctx }, {
                  mappingId: mapping.id,
                  channelId: channel.id,
                });
              }
            }
            return channel;
          });
          success += 1;
          details.push({ index, ok: true, channelId: created.id, name: item.name });
        } catch (e) {
          // 单条失败不裸漏 PG 内部：HttpError 语义文案，其余统一收口
          details.push({
            index,
            ok: false,
            name: item.name,
            error:
              e instanceof AppError
                ? e.message
                : (e as { code?: string }).code === '23505'
                  ? '同名渠道已存在'
                  : '导入失败（数据冲突或校验不过）',
          });
        }
      }

      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'channel.import',
        targetType: 'channel',
        detail: { total: input.channels.length, success },
      });
      return { total: input.channels.length, success, failed: input.channels.length - success, details };
    },

    async probe(ctx, channelId) {
      const channel = await repos.channel.findChannelForProbe({ db, ...ctx }, channelId);
      if (!channel) throw new AppError(404, 'channel_not_found', '渠道不存在');
      const startedAt = Date.now();
      try {
        const apiKey = decrypt(channel.apiKeyEnc, deps.encryptionKey);
        const keyPreview = maskUpstreamKey(apiKey);
        const result = await deps.createTester().probe({
          baseUrl: channel.baseUrlOverride ?? channel.providerBaseUrl,
          apiKey,
          protocol: channel.providerProtocol,
        });
        return {
          ok: result.ok,
          durationMs: result.durationMs,
          error: result.error ? { code: result.error.code, message: result.error.message } : undefined,
          keyPreview,
        };
      } catch (e) {
        // 适配器异常与密文损坏（decrypt 抛）都是探针结果，不是管理面 500
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: { code: 'internal', message: e instanceof Error ? e.message : String(e) },
          keyPreview: undefined,
        };
      }
    },
  };
}
