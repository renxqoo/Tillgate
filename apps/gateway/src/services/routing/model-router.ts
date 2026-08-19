import type { Redis } from 'ioredis';
import type { Db } from '@ai-gateway/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { channels, modelChannels, modelMappings, providers, usageLogs } from '@ai-gateway/db/schema';
import type { ParamRules } from '@ai-gateway/ai';
import { decrypt } from '@ai-gateway/core';
import { toDecimal } from '@ai-gateway/wallet/metering';

/**
 * 路由缓存（模型映射 + 渠道解析）—— 消除热路径每请求查 DB。
 *
 * 失效策略：版本计数（version-counter invalidation）。
 *   - 单一 Redis 计数器 route:cache:v，任何对 providers/channels/model_mappings/model_channels
 *     的写操作都 bump 版本（管理端写库后调用 invalidate）。
 *   - 缓存 key 含版本号：bump 后旧 key 全部「隐形」（等 TTL 自然过期），新读按新版本重建。
 *   - TTL 兜底（5min）：防漏 bump 导致永久脏。
 *
 * 降级：Redis 不可用时跳过缓存直接查 DB（正确但慢，fail-open）。
 */

const VERSION_KEY = 'route:cache:v';
const CACHE_TTL_SEC = 300; // 5 分钟兜底（版本 bump 是主失效手段）

/**
 * 渠道调度排序（单一真相）：priority 高的层严格在前；同层内按 weight 做
 * 无放回加权随机——weight 是流量份额（weight=9 的渠道获得 ~9/10 的首发流量），
 * 而非确定性 tie-break（头部渠道吸收全部流量直到熔断，违背权重语义）。
 * weight<=0 按 1 处理（与 new-api 的权重平滑一致：全 0 时等概率）。
 */
export function weightedOrderByPriority<T extends { mcPriority: number; mcWeight: number }>(
  candidates: T[],
): T[] {
  const tiers = new Map<number, T[]>();
  for (const ch of candidates) {
    const tier = tiers.get(ch.mcPriority);
    if (tier) tier.push(ch);
    else tiers.set(ch.mcPriority, [ch]);
  }
  const ordered: T[] = [];
  for (const priority of [...tiers.keys()].toSorted((a, b) => b - a)) {
    const pool = [...tiers.get(priority)!];
    while (pool.length > 0) {
      const total = pool.reduce((sum, ch) => sum + Math.max(1, ch.mcWeight), 0);
      let pick = Math.random() * total;
      let index = 0;
      for (; index < pool.length - 1; index++) {
        pick -= Math.max(1, pool[index]!.mcWeight);
        if (pick <= 0) break;
      }
      ordered.push(pool.splice(index, 1)[0]!);
    }
  }
  return ordered;
}
const EMPTY_MARKER = '__empty__'; // 缓存「不存在」结果（防穿透：已下架模型反复查 DB）
/** channels 缓存结构版本：形状变化时 bump，使旧 key 自然 miss */
const CHANNELS_SCHEMA_V = 3;

export interface MappingCache {
  id: number;
  externalName: string;
  realModel: string;
  status: number;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 计费单位（token/request/image/second/char）与单位单价——计价公式单一真相 money/amount.ts */
  pricingUnit: string;
  unitPrice: string;
  /** 定价分组键（费率卡 scope='group' 系数行匹配用；null=不参与分组系数） */
  pricingGroup: string | null;
  fallbackModels: string[] | null;
  paramRules: ParamRules | null;
  billingPolicy: Record<string, unknown> | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 显式免费模型（model_mappings.is_free）：授权走 0 元 fast-path，不预留余额/额度。 */
  isFree: boolean;
}

/** 渠道缓存项（getChannels 返回值）。
 * apiKey 是解密后的明文——仅在进程内存，永不落 Redis / 日志。
 */
export interface ChannelCache {
  channelId: number;
  baseUrl: string;
  /** 解密后的 apiKey（敏感：仅在进程内存，永不日志/返回/落 Redis） */
  apiKey: string;
  /** 协议 = ai 包适配器注册表键（DB 原值直存，词表单一真相见 SUPPORTED_PROTOCOLS） */
  protocol: string;
  providerName: string;
  key: string;
  /** 渠道级限流（保护上游 API key 配额；null=该渠道不限流） */
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 进货总额（元，0=未接入进货管理） */
  upstreamBudget: string;
  /** 剩余额度 = budget - 已结算上游成本（元，string） */
  upstreamRemaining: string;
}

/** 落 Redis 的缓存项（C1 修复后：只存密文 apiKeyEnc，不存明文 apiKey） */
interface ChannelCacheStored {
  channelId: number;
  baseUrl: string;
  apiKeyEnc: string;
  /** 协议 = ai 包适配器注册表键（与 ChannelCache 同词表，DB 原值直存） */
  protocol: string;
  providerName: string;
  key: string;
  rpmLimit: number | null;
  tpmLimit: number | null;
  upstreamBudget: string;
  upstreamRemaining: string;
}

export interface ModelRouter {
  /**
   * 按 externalName 查模型映射（命中缓存跳过 DB）。
   * @returns 映射对象，或 null（不存在/已下架）。Redis 不可用或 miss 时查 DB 并回填。
   */
  getMapping(externalName: string): Promise<MappingCache | null>;
  /** 上架模型名列表（OpenAI /v1/models 用，Redis 缓存 + 版本失效）。 */
  listEnabledModels(): Promise<string[]>;
  /** 按 realModel 解析候选渠道（priority/weight 排序；空数组=无可用渠道）。 */
  getChannels(realModel: string): Promise<ChannelCache[]>;
  /** 失效路由缓存（bump 版本）。providers/channels/model_mappings/model_channels 写后调用。 */
  invalidate(): Promise<void>;
}

export function createModelRouter(
  db: Db,
  redis: Redis,
  encryptionKey: string,
  /** 轮换双 key 窗：旧密钥（v1 密文解密用；未设置 = 单 key 常态） */
  encryptionKeyOld?: string,
): ModelRouter {
  /** 读当前缓存版本（Redis 不可用返回 0 = 永远 miss，直接查 DB） */
  async function getVersion(): Promise<number> {
    try {
      const v = await redis.get(VERSION_KEY);
      return v ? Number(v) : 0;
    } catch {
      return 0;
    }
  }

  return {
    async getMapping(externalName: string): Promise<MappingCache | null> {
      const v = await getVersion();
      const key = `route:mapping:v${v}:${externalName}`;
      try {
        const cached = await redis.get(key);
        if (cached !== null) {
          if (cached === EMPTY_MARKER) return null;
          return JSON.parse(cached) as MappingCache;
        }
      } catch {
        // Redis 不可用 → 查 DB
      }
      const row = await db.query.modelMappings.findFirst({
        where: and(eq(modelMappings.externalName, externalName), eq(modelMappings.status, 0)),
      });
      const result = row
        ? {
            id: row.id,
            externalName: row.externalName,
            realModel: row.realModel,
            status: row.status,
            inputPrice: row.inputPrice,
            outputPrice: row.outputPrice,
            cacheInputPrice: row.cacheInputPrice,
            pricingUnit: row.pricingUnit,
            unitPrice: row.unitPrice,
            pricingGroup: row.pricingGroup ?? null,
            fallbackModels: row.fallbackModels ?? null,
            paramRules: row.paramRules ?? null,
            billingPolicy: row.billingPolicy ?? null,
            rpmLimit: row.rpmLimit,
            tpmLimit: row.tpmLimit,
            isFree: row.isFree,
          }
        : null;
      try {
        await redis.set(
          key,
          result ? JSON.stringify(result) : EMPTY_MARKER,
          'EX',
          CACHE_TTL_SEC,
        );
      } catch {
        /* Redis 不可用：不回填，下次仍查 DB */
      }
      return result;
    },

    async listEnabledModels(): Promise<string[]> {
      const v = await getVersion();
      const key = `route:models:v${v}`;
      try {
        const cached = await redis.get(key);
        if (cached !== null) {
          return cached === EMPTY_MARKER ? [] : (JSON.parse(cached) as string[]);
        }
      } catch {
        // Redis 不可用 → 查 DB
      }
      const rows = await db.query.modelMappings.findMany({
        where: eq(modelMappings.status, 0),
        columns: { externalName: true },
      });
      const names = rows.map((m) => m.externalName);
      try {
        await redis.set(
          key,
          names.length > 0 ? JSON.stringify(names) : EMPTY_MARKER,
          'EX',
          CACHE_TTL_SEC,
        );
      } catch {
        /* Redis 不可用：不回填 */
      }
      return names;
    },

    async getChannels(realModel: string): Promise<ChannelCache[]> {
      const v = await getVersion();
      const key = `route:channels:v${v}:s${CHANNELS_SCHEMA_V}:${realModel}`;
      try {
        const cached = await redis.get(key);
        if (cached !== null) {
          if (cached === EMPTY_MARKER) return [];
          // Redis 存的是密文版（ChannelCacheStored），读出后在内存解密成 ChannelCache
          const stored = JSON.parse(cached) as ChannelCacheStored[];
          return stored.map((s) => ({ ...s, apiKey: decrypt(s.apiKeyEnc, encryptionKey, encryptionKeyOld) }));
        }
      } catch {
        // Redis 不可用 → 查 DB
      }
      let rows = await db
        .select({
          channelId: channels.id,
          channelName: channels.name,
          apiKeyEnc: channels.apiKeyEnc,
          baseUrlOverride: channels.baseUrlOverride,
          providerName: providers.name,
          providerBaseUrl: providers.baseUrl,
          providerProtocol: providers.protocol,
          mcWeight: modelChannels.weight,
          mcPriority: modelChannels.priority,
          rpmLimit: channels.rpmLimit,
          tpmLimit: channels.tpmLimit,
          upstreamBudget: channels.upstreamBudget,
        })
        .from(modelChannels)
        .innerJoin(channels, eq(modelChannels.channelId, channels.id))
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
        .where(and(eq(modelMappings.realModel, realModel), eq(channels.status, 0)))
        .orderBy(desc(modelChannels.priority), desc(modelChannels.weight));
      // 调度：priority 分层保持层间降序；层内按 weight 加权随机——
      // weight 语义为流量份额而非 tie-break（否则头部渠道吸收 100% 流量直到熔断）
      rows = weightedOrderByPriority(rows);

      // 渠道进货消耗聚合：consumed = sum(upstream_cost)，只计成功结算
      const channelIds = rows.map((row) => row.channelId);
      let consumedMap = new Map<number, string>();
      if (channelIds.length > 0) {
        const consumedRows = await db
          .select({
            channelId: usageLogs.channelId,
            total: sql<string>`coalesce(sum(${usageLogs.upstreamCost}),0)::numeric`,
          })
          .from(usageLogs)
          .where(and(inArray(usageLogs.channelId, channelIds), eq(usageLogs.status, 0)))
          .groupBy(usageLogs.channelId);
        for (const cr of consumedRows) {
          if (cr.channelId != null) consumedMap.set(cr.channelId, cr.total);
        }
      }

      // 内存对象含解密明文 apiKey（供调用方用）；落 Redis 的只含密文 apiKeyEnc
      const memResult: ChannelCache[] = rows.map((row) => ({
        channelId: row.channelId,
        baseUrl: row.baseUrlOverride ?? row.providerBaseUrl,
        apiKey: decrypt(row.apiKeyEnc, encryptionKey, encryptionKeyOld),
        protocol: row.providerProtocol,
        providerName: row.providerName,
        key: `${row.providerName}/${row.channelName}`,
        rpmLimit: row.rpmLimit,
        tpmLimit: row.tpmLimit,
        upstreamBudget: row.upstreamBudget,
        upstreamRemaining: toDecimal(row.upstreamBudget)
          .minus(toDecimal(consumedMap.get(row.channelId) ?? '0'))
          .toString(),
      }));
      const storedResult: ChannelCacheStored[] = rows.map((row) => ({
        channelId: row.channelId,
        baseUrl: row.baseUrlOverride ?? row.providerBaseUrl,
        apiKeyEnc: row.apiKeyEnc,
        protocol: row.providerProtocol,
        providerName: row.providerName,
        key: `${row.providerName}/${row.channelName}`,
        rpmLimit: row.rpmLimit,
        tpmLimit: row.tpmLimit,
        upstreamBudget: row.upstreamBudget,
        upstreamRemaining: toDecimal(row.upstreamBudget)
          .minus(toDecimal(consumedMap.get(row.channelId) ?? '0'))
          .toString(),
      }));

      try {
        await redis.set(
          key,
          storedResult.length > 0 ? JSON.stringify(storedResult) : EMPTY_MARKER,
          'EX',
          CACHE_TTL_SEC,
        );
      } catch {
        /* Redis 不可用：不回填 */
      }
      return memResult;
    },

    async invalidate(): Promise<void> {
      try {
        await redis.incr(VERSION_KEY);
      } catch {
        // Redis 不可用：无缓存可失效（降级模式下所有读都直查 DB），静默
      }
    },
  };
}
