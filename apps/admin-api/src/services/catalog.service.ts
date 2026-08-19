/**
 * 模型目录服务：目录源货架（拉取 + 比对）+ 一键导入 + 厂商预设档案。
 *
 * 目录 = 临时货架（内存缓存，不落库）；导入落的是既有三层
 * provider/channel/model_mappings，无新概念。整个导入单事务：中途任何失败
 * （如外部名冲突）整体回滚，不留半成品（M3——provider/免费渠道/部分映射的脏状态）。
 *
 * 护栏（默认平台价能安全成立的前提）：
 *   - 价格必填（前端预填平台价，提交即确认；目录价绝不静默写入）
 *   - 免费渠道 rpm/进货额度预填（装配注入）
 *   - 渠道名 free- 前缀（复核/客服一眼可辨免费上游）
 *   - key 只在渠道首次创建时填，AES 加密落库；重复导入复用不覆盖
 * R6：isFree 由价格全零推导（不由 :free 命名约定推断——目录漂移出非零价时按付费导入）。
 */
import { encrypt } from '@ai-gateway/core';
import type { Redis } from 'ioredis';
import { recordAudit } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import {
  compareCatalog,
  mapOpenAiCompatibleCatalog,
  type CatalogComparison,
} from '../domain/catalog.js';
import { isFreeByPrice } from '../domain/model-pricing.js';

/** 目录源 adapter：拉取 + 映射 + 落库命名（新增源 = 在装配注册一个 adapter） */
export interface CatalogSource {
  id: string;
  /** 展示名（前端 Tab） */
  name: string;
  /** 落库 provider 名（目录源即供应商） */
  providerName: string;
  providerBaseUrl: string;
  providerProtocol: string;
  /** 免费渠道名（free- 前缀护栏） */
  channelName: string;
  /** 导入是否需要平台 API key */
  needsKey: boolean;
  /** 拉目录原始数据（公开接口） */
  fetchModels(): Promise<unknown>;
}

/** 默认源：OpenRouter 公开目录（OpenAI 兼容面） */
export const OPENROUTER_SOURCE: CatalogSource = {
  id: 'openrouter',
  name: 'OpenRouter',
  providerName: 'openrouter',
  providerBaseUrl: 'https://openrouter.ai/api',
  providerProtocol: 'openai-compatible',
  channelName: 'free-openrouter',
  needsKey: true,
  fetchModels: async () => {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`openrouter catalog fetch failed: ${res.status}`);
    return res.json();
  },
};

export interface CatalogServiceDeps {
  db: Db;
  repos?: Repositories;
  redis: Redis | null;
  /** 目录源注册表（装配注入；测试注入 mock 源） */
  sources: readonly CatalogSource[];
  /** 源拉取缓存 TTL（ms） */
  cacheTtlMs: number;
  /** 免费渠道限流预填 */
  freeChannelRpm: number;
  /** 免费渠道进货额度预填 */
  freeChannelBudget: string;
  /** 渠道密钥加密密钥（单 key 单格式 enc:v1） */
  encryptionKey: string;
}

export interface CatalogImportModelInput {
  externalName: string;
  realModel: string;
  /** 价格必填（提交即确认；目录价只展示不自动带入） */
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 上下文窗口（token）；目录带入，可空 */
  contextLength?: number | null;
}

export interface CatalogService {
  /** 目录源清单（前端 Tab） */
  listSources(): Array<{ id: string; name: string; needsKey: boolean; channelName: string }>;
  /** 拉取目录并与库内比对（已导入回填 + 漂移警告 + 免费渠道就绪探测） */
  comparison(ctx: RunContext, sourceId: string): Promise<{
    source: string;
    fetchedAt: string;
    channelReady: boolean;
    channelRpmLimit: number | null;
    items: CatalogComparison[];
  }>;
  /** 一键入库（单事务：provider/channel find-or-create + 映射 upsert + 幂等绑定） */
  import(
    ctx: RunContext,
    input: { adminId: number; sourceId: string; apiKey?: string; models: CatalogImportModelInput[] },
  ): Promise<{ providerId: number; channelId: number; created: number; updated: number }>;
}

export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const sourcesById = new Map(deps.sources.map((s) => [s.id, s]));

  // 源拉取缓存（进程内存；TTL 装配注入）
  const sourceCaches = new Map<string, { fetchedAt: number; raw: unknown }>();

  function getSource(sourceId: string): CatalogSource {
    const source = sourcesById.get(sourceId);
    if (!source) {
      throw new AppError(404, 'catalog_source_not_found', `未知的目录源：${sourceId}`);
    }
    return source;
  }

  async function fetchSourceModels(source: CatalogSource): Promise<{ fetchedAt: number; raw: unknown }> {
    const cached = sourceCaches.get(source.id);
    if (cached && Date.now() - cached.fetchedAt < deps.cacheTtlMs) {
      return { fetchedAt: cached.fetchedAt, raw: cached.raw };
    }
    const raw = await source.fetchModels();
    const entry = { fetchedAt: Date.now(), raw };
    sourceCaches.set(source.id, entry);
    return entry;
  }

  return {
    listSources() {
      return deps.sources.map((s) => ({
        id: s.id,
        name: s.name,
        needsKey: s.needsKey,
        channelName: s.channelName,
      }));
    },

    async comparison(ctx, sourceId) {
      const source = getSource(sourceId);
      const { fetchedAt, raw } = await fetchSourceModels(source);
      // OpenAI 兼容映射是源协议的一部分；非兼容源应自带 mapModels（扩展点）
      const items = mapOpenAiCompatibleCatalog(raw);
      const existing = await repos.modelMapping.listEnabledByRealModels(
        { db, ...ctx },
        items.map((i) => i.realModel),
      );
      const freeChannel = await repos.channel.findChannelByName({ db, ...ctx }, source.channelName);
      return {
        source: source.id,
        fetchedAt: new Date(fetchedAt).toISOString(),
        channelReady: freeChannel != null,
        channelRpmLimit: freeChannel?.rpmLimit ?? null,
        items: compareCatalog(items, existing),
      };
    },

    async import(ctx, input) {
      if (input.models.length === 0) {
        throw new AppError(400, 'catalog_empty', '至少选择一个模型');
      }
      const source = getSource(input.sourceId);

      const result = await db.transaction(async (tx) => {
        const c = { db: tx, ...ctx };
        // provider find-or-create（目录源即供应商）
        let provider = await repos.provider.findByName(c, source.providerName);
        if (!provider) {
          provider = await repos.provider.insert(c, {
            name: source.providerName,
            protocol: source.providerProtocol,
            baseUrl: source.providerBaseUrl,
          });
        }

        // 免费渠道 find-or-create（首次需要平台 key；复用不覆盖已存 key）
        let channelId: number;
        const existingChannel = await repos.channel.findChannelByName(c, source.channelName);
        if (existingChannel) {
          channelId = existingChannel.id;
        } else {
          if (!input.apiKey && source.needsKey) {
            throw new AppError(400, 'api_key_required', `首次从 ${source.name} 导入需要填写平台 API Key（用于创建渠道）`);
          }
          const created = await repos.channel.insertChannel(c, {
            providerId: provider.id,
            name: source.channelName,
            apiKeyEnc: encrypt(input.apiKey ?? 'no-key-required', deps.encryptionKey),
            rpmLimit: deps.freeChannelRpm,
            upstreamBudget: deps.freeChannelBudget,
          });
          channelId = created.id;
        }

        let created = 0;
        let updated = 0;
        for (const m of input.models) {
          const existingMapping = await repos.modelMapping.findByExternalName(c, m.externalName);
          const prices = {
            inputPrice: m.inputPrice,
            outputPrice: m.outputPrice,
            cacheInputPrice: m.cacheInputPrice,
          };
          if (existingMapping) {
            if (existingMapping.realModel !== m.realModel) {
              // 外部名被其他真实模型占用 → 整体回滚（M3：不留半成品）
              throw new AppError(409, 'external_name_conflict', `对外名 ${m.externalName} 已绑定 ${existingMapping.realModel}，请换一个名字`);
            }
            // 重复导入 = 价格更新确认（同一真实模型）；isFree 按价格全零重推导
            await repos.modelMapping.updateMapping(c, {
              mappingId: existingMapping.id,
              patch: {
                ...prices,
                isFree: isFreeByPrice(prices),
                ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
              },
            });
            await repos.modelMapping.ensureModelChannelBinding(c, {
              mappingId: existingMapping.id,
              channelId,
            });
            updated += 1;
          } else {
            const inserted = await repos.modelMapping.insertMapping(c, {
              externalName: m.externalName,
              realModel: m.realModel,
              contextLength: m.contextLength ?? null,
              ...prices,
              isFree: isFreeByPrice(prices),
            });
            await repos.modelMapping.ensureModelChannelBinding(c, {
              mappingId: inserted.id,
              channelId,
            });
            created += 1;
          }
        }
        return { providerId: provider.id, channelId, created, updated };
      });

      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'model_catalog.import',
        targetType: 'provider',
        targetId: String(result.providerId),
        detail: {
          source: source.id,
          created: result.created,
          updated: result.updated,
          models: input.models.map((m) => m.externalName),
        },
      });
      return result;
    },
  };
}
