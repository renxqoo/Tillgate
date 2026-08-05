import type { Redis } from 'ioredis';
import type { Db } from '@ai-gateway/db';
import { and, desc, eq } from 'drizzle-orm';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db/schema';
import type { ChannelDesc } from '@ai-gateway/ai';
import { decrypt } from './crypto.js';

/**
 * 路由缓存（模型映射 + 渠道解析）—— 消除热路径每请求查 DB。
 *
 * 瓶颈背景：chat-completions 每请求查 DB 2~N 次（mapping findFirst + resolveChannels 多表 JOIN
 *   + fallback 模型 findFirst），DB 连接池 max:20，是单实例并发瓶颈（实测 ~600 后 TTFB 雪崩）。
 *
 * 失效策略：版本计数（version-counter invalidation）。
 *   - 单一 Redis 计数器 route:cache:v，任何对 providers/channels/model_mappings/model_channels
 *     的写操作都 bump 版本（invalidateRouteCache）。
 *   - 缓存 key 含版本号：bump 后旧 key 全部「隐形」（等 TTL 自然过期），新读按新版本重建。
 *   - 优点：无需追踪每个 key（PATCH 可能改 external_name/real_model 导致旧 key 漏删），
 *     版本 bump 一次清空全部，正确性有保障。
 *   - TTL 兜底（5min）：防漏 bump 导致永久脏。
 *
 * 降级：Redis 不可用时跳过缓存直接查 DB（正确但慢，与 billing fail-open 同策略）。
 */

const VERSION_KEY = 'route:cache:v';
const CACHE_TTL_SEC = 300; // 5 分钟兜底（版本 bump 是主失效手段）
const EMPTY_MARKER = '__empty__'; // 缓存「不存在」结果（防穿透：已下架模型反复查 DB）

// ---- 版本管理 ----

/** 读当前缓存版本（Redis 不可用返回 0 = 永远 miss，直接查 DB） */
async function getVersion(redis: Redis): Promise<number> {
  try {
    const v = await redis.get(VERSION_KEY);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

/**
 * 失效路由缓存（bump 版本）。
 * 任何对 providers/channels/model_mappings/model_channels 的写操作后调用。
 * Redis 不可用时静默（缓存要么不存在要么过时，TTL 兜底；下次读发现版本对不上会重建）。
 */
export async function invalidateRouteCache(redis: Redis): Promise<void> {
  try {
    await redis.incr(VERSION_KEY);
  } catch {
    // Redis 不可用：无缓存可失效（降级模式下所有读都直查 DB），静默
  }
}

// ---- JSON 序列化辅助（bigint 在 JSON.stringify 会抛，需手动转 number） ----

interface MappingCache {
  id: number;
  externalName: string;
  realModel: string;
  status: number;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  fallbackModels: string[] | null;
  paramRules: unknown;
  rpmLimit: number | null;
  tpmLimit: number | null;
}

/**
 * 进程内存中的渠道缓存项（getChannels 返回值）。
 * apiKey 是解密后的明文——仅在内存，永不落 Redis / 日志。
 */
export interface ChannelCache {
  channelId: number;
  baseUrl: string;
  /** 解密后的 apiKey（敏感：仅在进程内存，永不日志/返回/落 Redis） */
  apiKey: string;
  protocol: ChannelDesc['protocol'];
  providerName: string;
  key: string;
}

/**
 * 落 Redis 的缓存项（C1 修复后：只存密文 apiKeyEnc，不存明文 apiKey）。
 * Redis 落盘/共享/被攻破时泄露的是密文（需 ENCRYPTION_KEY 才能解），而非可用凭据。
 */
interface ChannelCacheStored {
  channelId: number;
  baseUrl: string;
  apiKeyEnc: string; // 密文（落 Redis 安全）
  protocol: ChannelDesc['protocol'];
  providerName: string;
  key: string;
}

// ---- 模型映射缓存 ----

/**
 * 按 externalName 查模型映射（命中缓存跳过 DB）。
 * @returns 映射对象，或 null（不存在/已下架）。Redis 不可用或 miss 时查 DB 并回填。
 */
export async function getMapping(
  db: Db,
  redis: Redis,
  externalName: string,
): Promise<MappingCache | null> {
  const v = await getVersion(redis);
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
  // miss / 降级：查 DB
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
        fallbackModels: row.fallbackModels ?? null,
        paramRules: row.paramRules ?? null,
        rpmLimit: row.rpmLimit,
        tpmLimit: row.tpmLimit,
      }
    : null;
  // 回填缓存（Redis 不可用时静默跳过）
  try {
    await redis.set(key, result ? JSON.stringify(result) : EMPTY_MARKER, 'EX', CACHE_TTL_SEC);
  } catch {
    /* Redis 不可用：不回填，下次仍查 DB */
  }
  return result;
}

// ---- 渠道解析缓存 ----

/**
 * 按 realModel 解析候选渠道（命中缓存跳过 DB 多表 JOIN + 解密）。
 * @returns 渠道列表（按 priority/weight 排序），空数组表示无可用渠道。
 */
export async function getChannels(
  db: Db,
  redis: Redis,
  realModel: string,
  encryptionKey: string,
): Promise<ChannelCache[]> {
  const v = await getVersion(redis);
  const key = `route:channels:v${v}:${realModel}`;
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      if (cached === EMPTY_MARKER) return [];
      // Redis 存的是密文版（ChannelCacheStored），读出后在内存解密成 ChannelCache
      const stored = JSON.parse(cached) as ChannelCacheStored[];
      return stored.map((s) => ({ ...s, apiKey: decrypt(s.apiKeyEnc, encryptionKey) }));
    }
  } catch {
    // Redis 不可用 → 查 DB
  }
  // miss / 降级：查 DB + 解密（与 resolveChannels 原逻辑一致）
  const rows = await db
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
    })
    .from(modelChannels)
    .innerJoin(channels, eq(modelChannels.channelId, channels.id))
    .innerJoin(providers, eq(channels.providerId, providers.id))
    .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
    .where(and(eq(modelMappings.realModel, realModel), eq(channels.status, 0)))
    .orderBy(desc(modelChannels.priority), desc(modelChannels.weight));

  // C1 修复：内存对象含解密明文 apiKey（供调用方用）；落 Redis 的只含密文 apiKeyEnc。
  const memResult: ChannelCache[] = rows.map((row) => ({
    channelId: row.channelId,
    baseUrl: row.baseUrlOverride ?? row.providerBaseUrl,
    apiKey: decrypt(row.apiKeyEnc, encryptionKey),
    protocol: row.providerProtocol.replace('_', '-') as ChannelDesc['protocol'],
    providerName: row.providerName,
    key: `${row.providerName}/${row.channelName}`,
  }));
  // 落 Redis 的版本：apiKeyEnc（密文），不含明文
  const storedResult: ChannelCacheStored[] = rows.map((row) => ({
    channelId: row.channelId,
    baseUrl: row.baseUrlOverride ?? row.providerBaseUrl,
    apiKeyEnc: row.apiKeyEnc,
    protocol: row.providerProtocol.replace('_', '-') as ChannelDesc['protocol'],
    providerName: row.providerName,
    key: `${row.providerName}/${row.channelName}`,
  }));

  try {
    await redis.set(key, storedResult.length > 0 ? JSON.stringify(storedResult) : EMPTY_MARKER, 'EX', CACHE_TTL_SEC);
  } catch {
    /* Redis 不可用：不回填 */
  }
  return memResult;
}
