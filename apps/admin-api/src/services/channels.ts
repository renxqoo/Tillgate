import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { providers, channels, modelMappings, modelChannels } from '@ai-gateway/db/schema';
import { buildList, bumpRouteCache, countAll, encryptCurrent, HttpError, listQuerySchema, paginateQuery, recordAudit } from '@ai-gateway/http';
import { and, inArray, sql } from 'drizzle-orm';
import { usageLogs } from '@ai-gateway/db/schema';
import type { AdminServices } from './index.js';

/**
 * 渠道服务：批量导入 + 上游 Key 加密。
 *
 * 导入设计（api-contract §4.5：POST /api/admin/channels/import）：
 *   - 输入 JSON 数组，每项 { provider, name, apiKey, models?, weight?, priority? }
 *   - provider 按 name 精确匹配（不存在则报错，避免误建错配置的供应商）
 *   - 单条失败不中断整体导入（best-effort），逐条明细便于运营定位
 *   - models 命中已有 model_mappings 时自动绑定（onConflictDoNothing 去重）
 *
 * 安全：上游 Key 明文只在请求体中出现一次，落库 AES-256-GCM 密文（core encrypt）。
 */

export const importItemSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(512),
  models: z.array(z.string()).optional(),
  weight: z.number().int().min(1).optional(),
  priority: z.number().int().optional(),
});

export const channelImportSchema = z.object({
  channels: z.array(importItemSchema).min(1).max(1000),
});

export type ChannelImportItem = z.infer<typeof importItemSchema>;

export interface ChannelImportDetail {
  index: number;
  ok: boolean;
  channelId?: number;
  name: string;
  error?: string;
}

export interface ChannelImportResult {
  total: number;
  success: number;
  failed: number;
  details: ChannelImportDetail[];
}

export async function importChannels(
  s: AdminServices,
  items: ChannelImportItem[],
  adminId: number,
): Promise<ChannelImportResult> {
  const details: ChannelImportDetail[] = [];
  let success = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    try {
      // 1. 查供应商（按 name 精确匹配，不存在则报错）
      const provider = await s.db
        .select({ id: providers.id, name: providers.name })
        .from(providers)
        .where(eq(providers.name, item.provider))
        .limit(1);
      if (provider.length === 0) {
        details.push({ index: i, ok: false, name: item.name, error: `供应商「${item.provider}」不存在，请先创建` });
        continue;
      }

      // 2. 同名渠道查重（避免重复导入）
      const existing = await s.db
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.name, item.name))
        .limit(1);
      if (existing.length > 0) {
        details.push({ index: i, ok: false, name: item.name, error: '同名渠道已存在' });
        continue;
      }

      // 3. 加密 key + 建渠道
      const apiKeyEnc = encryptCurrent(item.apiKey, s.encryptionKey, s.encryptionKeyOld);
      const [created] = await s.db
        .insert(channels)
        .values({
          providerId: provider[0]!.id,
          name: item.name,
          apiKeyEnc,
          models: item.models ?? null,
          weight: item.weight ?? 1,
          priority: item.priority ?? 0,
          status: 0,
        })
        .returning({ id: channels.id });

      // 4. 若 models 提供，且存在对应 model_mappings，自动绑定（便利功能）
      if (item.models && created) {
        for (const modelName of item.models) {
          const mapping = await s.db
            .select({ id: modelMappings.id })
            .from(modelMappings)
            .where(eq(modelMappings.externalName, modelName))
            .limit(1);
          if (mapping.length > 0) {
            await s.db
              .insert(modelChannels)
              .values({ mappingId: mapping[0]!.id, channelId: created.id, weight: item.weight ?? 1, priority: item.priority ?? 0 })
              .onConflictDoNothing();
          }
        }
      }

      details.push({ index: i, ok: true, channelId: created!.id, name: item.name });
      success++;
      s.logger.info({ channelId: created!.id, name: item.name }, 'channel imported');
    } catch (err) {
      details.push({
        index: i,
        ok: false,
        name: item.name,
        // 不回传底层异常原文（可能含 PG 约束名/驱动细节）——只给分类语义
        error: err instanceof HttpError ? err.message : '导入失败（数据冲突或校验不过）',
      });
    }
  }

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'channel.import',
    targetType: 'channel',
    detail: { total: items.length, success },
  });
  // 批量失效路由缓存（一次 bump 覆盖整批导入，而非逐条）
  if (success > 0) await bumpRouteCache(s.redis);

  return { total: items.length, success, failed: items.length - success, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// 渠道 CRUD（写流程 + Key 加密 + 审计 + 路由缓存失效）
// ─────────────────────────────────────────────────────────────────────────────

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

export async function createChannel(
  s: AdminServices,
  input: ChannelCreateInput,
  adminId: number,
): Promise<{ id: number; name: string; providerId: number }> {
  // 明文 key → AES 加密 → 存 DB（明文不保留在任何返回值/日志中）
  const apiKeyEnc = encryptCurrent(input.apiKey, s.encryptionKey, s.encryptionKeyOld);
  const [created] = await s.db
    .insert(channels)
    .values({
      providerId: input.providerId,
      name: input.name,
      apiKeyEnc,
      baseUrlOverride: input.baseUrlOverride ?? null,
      models: input.models ?? null,
      weight: input.weight ?? 1,
      priority: input.priority ?? 0,
      rpmLimit: input.rpmLimit ?? null,
      tpmLimit: input.tpmLimit ?? null,
      status: 0,
    })
    .returning({ id: channels.id, name: channels.name, providerId: channels.providerId });
  s.logger.info({ channelId: created!.id, name: created!.name }, 'channel created (key encrypted)');
  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'channel.create',
    targetType: 'channel',
    targetId: created!.id,
    detail: { name: created!.name, providerId: created!.providerId },
  });
  return created!;
}

export interface ChannelPatch {
  name?: string;
  baseUrlOverride?: string | null;
  models?: string[] | null;
  weight?: number;
  priority?: number;
  status?: number;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  upstreamThreshold?: number | null;
  /** 换 Key：重新加密 + 恢复启用状态 */
  apiKey?: string;
}

export async function updateChannel(
  s: AdminServices,
  id: number,
  patch: ChannelPatch,
  adminId: number,
): Promise<{ id: number; name: string; status: number; failCount: number }> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.baseUrlOverride !== undefined) update.baseUrlOverride = patch.baseUrlOverride;
  if (patch.models !== undefined) update.models = patch.models;
  if (patch.weight !== undefined) update.weight = patch.weight;
  if (patch.priority !== undefined) update.priority = patch.priority;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.rpmLimit !== undefined) update.rpmLimit = patch.rpmLimit;
  if (patch.tpmLimit !== undefined) update.tpmLimit = patch.tpmLimit;
  if (patch.upstreamThreshold !== undefined) {
    update.upstreamThreshold = patch.upstreamThreshold == null ? null : String(patch.upstreamThreshold);
  }
  // 换 Key：重新加密 + 清除「凭据无效」状态（status=4 死凭据/3 熔断 → 恢复启用）
  if (patch.apiKey !== undefined) {
    update.apiKeyEnc = encryptCurrent(patch.apiKey, s.encryptionKey, s.encryptionKeyOld);
    update.status = 0;
    update.failCount = 0;
    update.cooldownUntil = null;
  }
  const [updated] = await s.db.update(channels).set(update).where(eq(channels.id, id)).returning({
    id: channels.id,
    name: channels.name,
    status: channels.status,
    failCount: channels.failCount,
  });
  if (!updated) throw new HttpError('CHANNEL_NOT_FOUND', '渠道不存在');
  await bumpRouteCache(s.redis);
  s.logger.info({ channelId: id, keyChanged: patch.apiKey !== undefined }, 'channel updated');
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'channel.update',
    targetType: 'channel',
    targetId: id,
    detail: {
      keyChanged: patch.apiKey !== undefined,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    },
  });
  return updated;
}

/** 删除 = 软退场（status=1），历史调用记录引用不受影响 */
export async function retireChannel(s: AdminServices, id: number, adminId: number): Promise<void> {
  const [retired] = await s.db
    .update(channels)
    .set({ status: 1, updatedAt: new Date() })
    .where(eq(channels.id, id))
    .returning({ id: channels.id });
  if (!retired) throw new HttpError('CHANNEL_NOT_FOUND', '渠道不存在');
  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'channel.retire',
    targetType: 'channel',
    targetId: id,
  });
}

export async function listChannels(s: AdminServices, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [channels.name, providers.name],
    sort: {
      by: {
        id: channels.id,
        name: channels.name,
        status: channels.status,
        priority: channels.priority,
        createdAt: channels.createdAt,
      },
      fallback: 'createdAt',
      tiebreaker: channels.id,
    },
  });

  const result = await paginateQuery(
    page,
    s.db
      .select({
        id: channels.id,
        providerId: channels.providerId,
        name: channels.name,
        baseUrlOverride: channels.baseUrlOverride,
        models: channels.models,
        weight: channels.weight,
        priority: channels.priority,
        status: channels.status,
        failCount: channels.failCount,
        cooldownUntil: channels.cooldownUntil,
        rpmLimit: channels.rpmLimit,
        tpmLimit: channels.tpmLimit,
        upstreamBudget: channels.upstreamBudget,
        upstreamThreshold: channels.upstreamThreshold,
        createdAt: channels.createdAt,
        updatedAt: channels.updatedAt,
        providerName: providers.name,
        providerBaseUrl: providers.baseUrl,
      })
      .from(channels)
      .innerJoin(providers, eq(channels.providerId, providers.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    // 计数与主查询同源 join（搜索目标含 providers.name）
    countAll(s.db, channels, where, [
      { table: providers, on: eq(channels.providerId, providers.id) },
    ]),
  );

  // 查当页渠道绑定的模型映射（分页后 inArray 限定，不再全表拉取）
  const pageIds = result.list.map((r) => r.id);
  const bindings = pageIds.length
    ? await s.db
        .select({
          channelId: modelChannels.channelId,
          externalName: modelMappings.externalName,
          realModel: modelMappings.realModel,
        })
        .from(modelChannels)
        .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
        .where(inArray(modelChannels.channelId, pageIds))
    : [];

  const bindingMap = new Map<number, Array<{ externalName: string; realModel: string }>>();
  for (const b of bindings) {
    const arr = bindingMap.get(b.channelId) ?? [];
    arr.push({ externalName: b.externalName, realModel: b.realModel });
    bindingMap.set(b.channelId, arr);
  }

  // 渠道已消耗（上游成本）聚合：consumed = sum(upstream_cost)，只计成功结算（报表用）
  const consumedRows = pageIds.length
    ? await s.db
        .select({
          channelId: usageLogs.channelId,
          total: sql<string>`coalesce(sum(${usageLogs.upstreamCost}),0)::numeric`,
        })
        .from(usageLogs)
        .where(and(eq(usageLogs.status, 0), inArray(usageLogs.channelId, pageIds)))
        .groupBy(usageLogs.channelId)
    : [];
  const consumedMap = new Map<number, string>();
  for (const cr of consumedRows) {
    if (cr.channelId != null) consumedMap.set(cr.channelId, cr.total);
  }

  const list = result.list.map((r) => {
    const consumed = consumedMap.get(r.id) ?? '0';
    return {
      ...r,
      boundModels: bindingMap.get(r.id) ?? [],
      // upstreamBudget 即「当前余额」（结算已扣减），已消耗单独给出供报表/追溯
      upstreamConsumed: consumed,
      upstreamRemaining: r.upstreamBudget,
    };
  });
  return { ...result, list };
}
