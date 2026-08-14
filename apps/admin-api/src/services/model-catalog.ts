import { and, eq, inArray } from 'drizzle-orm';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db/schema';
import { encrypt } from '@ai-gateway/core';
import { bumpRouteCache, HttpError, recordAudit } from '@ai-gateway/http';
import type { AdminServices } from './index.js';

/**
 * 模型市场目录源（多源架构）：目录 = 临时货架（内存缓存，不落库）；
 * 导入落的是既有三层 provider/channel/model_mappings，无新概念。
 *
 * 新增一个目录源 = 在 CATALOG_SOURCES 注册一个 adapter（id/名称/落库命名/
 * 是否需要 key/拉取+映射），路由与前端自动获得该源——不再改业务代码。
 *
 * 护栏（默认平台价能安全成立的前提）：
 *   - 价格必填（前端预填平台价，提交即确认；目录价绝不静默写入）
 *   - 渠道 rpm 预填 20（免费档典型限额，防打爆账号）
 *   - 渠道名 free- 前缀（复核/客服一眼可辨免费上游）
 *   - key 只在渠道首次创建时填，AES 加密落库
 * 漂移：GET 比对当前目录价与库里卖价，上游收费而我们仍 0 卖 → priceWarning。
 */

/** 免费档渠道限流预填（公开免费档限额量级） */
export const FREE_CHANNEL_RPM = 20;
/** 免费渠道进货额度：上游真实成本为 0，但管理员可改卖价（upstreamEstimate 随卖价走），给足余量 */
const FREE_CHANNEL_BUDGET = '1000000';

export interface CatalogModel {
  /** 上游真实模型 id（如 meta-llama/llama-3.3-70b-instruct:free） */
  realModel: string;
  /** 上游展示名 */
  displayName: string;
  contextLength: number | null;
  /** 目录参考价（USD/token 字符串；免费为 "0"）——只展示，不自动成为卖价 */
  catalogPromptUsd: string;
  catalogCompletionUsd: string;
  /** 对外名建议（去厂商前缀与 :free 后缀） */
  suggestedName: string;
  /** 已导入回填（我们的卖价） */
  imported: {
    externalName: string;
    inputPrice: string;
    outputPrice: string;
  } | null;
  /** 上游目录价 > 0 而我们的卖价 = 0 → 亏钱风险，页面标红 */
  priceWarning: boolean;
}

/** 目录源 adapter：拉取 + 映射 + 落库命名（新增源只加这里） */
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
  /** 原始数据 → 免费模型目录（纯函数，各自源独立实现） */
  mapModels(raw: unknown): Omit<CatalogModel, 'imported' | 'priceWarning'>[];
}

/** 对外名建议：`meta-llama/llama-3.3-70b-instruct:free` → `llama-3.3-70b-instruct` */
export function suggestExternalName(id: string): string {
  const stripped = id.replace(/:free$/, '');
  const segments = stripped.split('/');
  return (segments[segments.length - 1] || stripped).slice(0, 64);
}

/** OpenAI 兼容 models 列表 → 免费模型目录（pricing 全 0 判定；OpenRouter/SiliconFlow 等同构） */
export function mapOpenAiCompatibleCatalog(raw: unknown): Omit<CatalogModel, 'imported' | 'priceWarning'>[] {
  const data = (raw as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const items: Omit<CatalogModel, 'imported' | 'priceWarning'>[] = [];
  for (const m of data) {
    const row = m as {
      id?: unknown;
      name?: unknown;
      context_length?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    if (typeof row.id !== 'string' || row.id.length === 0) continue;
    const prompt = typeof row.pricing?.prompt === 'string' ? row.pricing.prompt : '';
    const completion =
      typeof row.pricing?.completion === 'string' ? row.pricing.completion : '';
    // 免费判定：输入输出目录价均为 0（:free 变体的公开特征）
    if (prompt !== '0' || completion !== '0') continue;
    items.push({
      realModel: row.id,
      displayName: typeof row.name === 'string' ? row.name : row.id,
      contextLength: typeof row.context_length === 'number' ? row.context_length : null,
      catalogPromptUsd: prompt,
      catalogCompletionUsd: completion,
      suggestedName: suggestExternalName(row.id),
    });
  }
  return items;
}

export const CATALOG_SOURCES: Record<string, CatalogSource> = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    providerName: 'openrouter',
    providerBaseUrl: 'https://openrouter.ai/api',
    providerProtocol: 'openai_compatible',
    channelName: 'free-openrouter',
    needsKey: true,
    fetchModels: async () => {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`openrouter catalog fetch failed: ${res.status}`);
      return res.json();
    },
    mapModels: mapOpenAiCompatibleCatalog,
  },
};

export function getCatalogSource(sourceId: string): CatalogSource {
  const source = CATALOG_SOURCES[sourceId];
  if (!source) {
    throw new HttpError(404, 'CATALOG_SOURCE_NOT_FOUND', `未知的目录源：${sourceId}`);
  }
  return source;
}

/** 目录 × 库内映射 → 回填已导入状态与漂移警告（纯函数） */
export function compareCatalog(
  items: Omit<CatalogModel, 'imported' | 'priceWarning'>[],
  existing: Array<{ externalName: string; realModel: string; inputPrice: string; outputPrice: string }>,
): CatalogModel[] {
  const byReal = new Map(existing.map((e) => [e.realModel, e]));
  return items.map((item) => {
    const ours = byReal.get(item.realModel) ?? null;
    const catalogCharged =
      Number(item.catalogPromptUsd) > 0 || Number(item.catalogCompletionUsd) > 0;
    const weSellFree = ours != null && Number(ours.inputPrice) === 0 && Number(ours.outputPrice) === 0;
    return {
      ...item,
      imported: ours,
      priceWarning: catalogCharged && weSellFree,
    };
  });
}

export interface ImportCatalogInput {
  sourceId: string;
  /** 平台 key：渠道首次创建时必填；复用已有渠道时可省（不覆盖已存 key） */
  apiKey?: string;
  models: Array<{
    externalName: string;
    realModel: string;
    /** 价格必填（提交即确认；目录价只展示不自动带入） */
    inputPrice: number;
    outputPrice: number;
    cacheInputPrice: number;
    /** 上下文窗口（token）；目录带入，可空 */
    contextLength?: number | null;
  }>;
}

export interface ImportCatalogResult {
  providerId: number;
  channelId: number;
  created: number;
  updated: number;
}

/** 一键入库：按源落 provider/channel（复用或创建），映射创建或价格更新，绑定到免费渠道 */
export async function importCatalogModels(
  s: AdminServices,
  input: ImportCatalogInput,
): Promise<ImportCatalogResult> {
  if (input.models.length === 0) {
    throw new HttpError(400, 'CATALOG_EMPTY', '至少选择一个模型');
  }
  const source = getCatalogSource(input.sourceId);

  let provider = await s.db.query.providers.findFirst({
    where: eq(providers.name, source.providerName),
  });
  if (!provider) {
    const [created] = await s.db
      .insert(providers)
      .values({
        name: source.providerName,
        baseUrl: source.providerBaseUrl,
        protocol: source.providerProtocol,
        status: 0,
      })
      .returning();
    provider = created!;
  }

  let channel = await s.db.query.channels.findFirst({
    where: eq(channels.name, source.channelName),
  });
  if (!channel) {
    if (!input.apiKey && source.needsKey) {
      throw new HttpError(
        400,
        'API_KEY_REQUIRED',
        `首次从 ${source.name} 导入需要填写平台 API Key（用于创建渠道）`,
      );
    }
    const [created] = await s.db
      .insert(channels)
      .values({
        providerId: provider.id,
        name: source.channelName,
        apiKeyEnc: encrypt(input.apiKey ?? 'no-key-required', s.encryptionKey),
        weight: 1,
        priority: 0,
        rpmLimit: FREE_CHANNEL_RPM,
        upstreamBudget: FREE_CHANNEL_BUDGET,
        status: 0,
      })
      .returning();
    channel = created!;
    s.logger.info({ channelId: channel.id }, 'catalog import: free channel created (key encrypted)');
  }

  let created = 0;
  let updated = 0;
  for (const m of input.models) {
    const existing = await s.db.query.modelMappings.findFirst({
      where: eq(modelMappings.externalName, m.externalName),
    });
    if (existing) {
      if (existing.realModel !== m.realModel) {
        // 外部名被其他真实模型占用：约束冲突在边界层翻译为业务错误
        throw new HttpError(
          409,
          'EXTERNAL_NAME_CONFLICT',
          `对外名 ${m.externalName} 已绑定 ${existing.realModel}，请换一个名字`,
        );
      }
      // 重复导入 = 价格更新确认（同一真实模型）。目录源只暴露免费档（全零价），
      // 免费标记显式落库，不再靠 `:free` 命名约定推断。
      await s.db
        .update(modelMappings)
        .set({
          inputPrice: String(m.inputPrice),
          outputPrice: String(m.outputPrice),
          cacheInputPrice: String(m.cacheInputPrice),
          isFree: true,
          ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
        })
        .where(eq(modelMappings.id, existing.id));
      await ensureBound(s, existing.id, channel.id);
      updated += 1;
    } else {
      const [inserted] = await s.db
        .insert(modelMappings)
        .values({
          externalName: m.externalName,
          realModel: m.realModel,
          status: 0,
          inputPrice: String(m.inputPrice),
          outputPrice: String(m.outputPrice),
          cacheInputPrice: String(m.cacheInputPrice),
          isFree: true,
          ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
        })
        .returning();
      await ensureBound(s, inserted!.id, channel.id);
      created += 1;
    }
  }

  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId: null,
    action: 'model_catalog.import',
    targetType: 'provider',
    targetId: String(provider.id),
    detail: { source: source.id, created, updated, models: input.models.map((m) => m.externalName) },
  });

  return { providerId: provider.id, channelId: channel.id, created, updated };
}

/** 绑定映射到免费渠道（已绑定时幂等） */
async function ensureBound(s: AdminServices, mappingId: number, channelId: number): Promise<void> {
  const bound = await s.db
    .select()
    .from(modelChannels)
    .where(and(eq(modelChannels.mappingId, mappingId), inArray(modelChannels.channelId, [channelId])));
  if (bound.length > 0) return;
  await s.db.insert(modelChannels).values({ mappingId, channelId, weight: 1, priority: 0 });
}
