import { eq } from 'drizzle-orm';
import { modelChannels, modelMappings } from '@ai-gateway/db/schema';
import { buildList, bumpRouteCache, countAll, HttpError, listQuerySchema, paginateQuery, recordAudit } from '@ai-gateway/http';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AdminServices } from './index.js';

/**
 * 模型服务：渠道绑定（全量替换语义，事务保证原子性）。
 *
 * 契约：POST /api/admin/models/:id/channels，body { channels: [{channelId, weight?, priority?}] }。
 * 全量替换 = 先删旧绑定再插新的，整体包在事务里——中途失败不会留下空绑定（旧实现删插分离，无事务）。
 */

/**
 * 免费口径一致性（R6 单一真相）：is_free 与价格互斥——显式免费模型必须全零价。
 * 授权侧（billing-flow.calculateRequired）按同一规则结构性拒绝矛盾报价，此处是
 * 配置写入侧的前置防线，供路由层创建/更新与目录导入共用。
 */
export function assertFreePriceConsistency(input: {
  isFree: boolean;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
}): void {
  if (!input.isFree) return;
  if (input.inputPrice > 0 || input.outputPrice > 0 || input.cacheInputPrice > 0) {
    throw new HttpError(
      'FREE_MODEL_PRICE_CONFLICT',
      '显式免费模型必须全零价（is_free 与非零价互斥），否则授权 0 元与结算实扣口径分裂',
    );
  }
}

export interface ChannelBind {
  channelId: number;
  weight?: number;
  priority?: number;
}

export async function replaceModelChannels(
  s: AdminServices,
  mappingId: number,
  binds: ChannelBind[],
  adminId: number,
): Promise<number> {
  const rows = binds.map((item) => ({
    mappingId,
    channelId: item.channelId,
    weight: item.weight ?? 1,
    priority: item.priority ?? 0,
  }));

  const count = await s.db.transaction(async (tx) => {
    await tx.delete(modelChannels).where(eq(modelChannels.mappingId, mappingId));
    if (rows.length > 0) {
      await tx.insert(modelChannels).values(rows);
    }
    return rows.length;
  });

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'model.bind_channels',
    targetType: 'model',
    targetId: mappingId,
    detail: { channelIds: rows.map((r) => r.channelId), count },
  });
  await bumpRouteCache(s.redis);

  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// 映射 CRUD（写流程 + 审计 + 路由缓存失效；kind/价格校验前置）
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelCreateInput {
  externalName: string;
  realModel: string;
  inputPrice?: number;
  outputPrice?: number;
  cacheInputPrice?: number;
  /** 显式免费模型（0 元授权）；付费模型必须 false */
  isFree?: boolean;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  billingPolicy?: Record<string, unknown> | null;
}

export interface ModelPatch {
  externalName?: string;
  realModel?: string;
  status?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheInputPrice?: number;
  isFree?: boolean;
  contextLength?: number | null;
  fallbackModels?: unknown;
  paramRules?: unknown;
  billingPolicy?: Record<string, unknown> | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

export async function createModel(
  s: AdminServices,
  input: ModelCreateInput,
  adminId: number,
): Promise<typeof modelMappings.$inferSelect> {
  assertFreePriceConsistency({
    isFree: input.isFree ?? false,
    inputPrice: input.inputPrice ?? 0,
    outputPrice: input.outputPrice ?? 0,
    cacheInputPrice: input.cacheInputPrice ?? 0,
  });
  const [created] = await s.db
    .insert(modelMappings)
    .values({
      externalName: input.externalName,
      realModel: input.realModel,
      status: 0,
      inputPrice: String(input.inputPrice ?? 0),
      outputPrice: String(input.outputPrice ?? 0),
      cacheInputPrice: String(input.cacheInputPrice ?? 0),
      isFree: input.isFree ?? false,
      rpmLimit: input.rpmLimit ?? null,
      tpmLimit: input.tpmLimit ?? null,
      billingPolicy: input.billingPolicy ?? null,
    })
    .returning();
  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'model.create',
    targetType: 'model',
    targetId: created!.id,
    detail: { externalName: input.externalName },
  });
  return created!;
}

export async function updateModel(
  s: AdminServices,
  id: number,
  patch: ModelPatch,
  adminId: number,
): Promise<typeof modelMappings.$inferSelect> {
  // 合并旧值做免费/价格互斥校验（R6）：部分更新只改 isFree 或只改价格都可能造成矛盾态
  const existing = await s.db.query.modelMappings.findFirst({
    where: eq(modelMappings.id, id),
    columns: { inputPrice: true, outputPrice: true, cacheInputPrice: true, isFree: true },
  });
  if (!existing) throw new HttpError('MODEL_NOT_FOUND', '模型不存在');
  assertFreePriceConsistency({
    isFree: patch.isFree ?? existing.isFree,
    inputPrice: patch.inputPrice ?? Number(existing.inputPrice),
    outputPrice: patch.outputPrice ?? Number(existing.outputPrice),
    cacheInputPrice: patch.cacheInputPrice ?? Number(existing.cacheInputPrice),
  });
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.externalName !== undefined) update.externalName = patch.externalName;
  if (patch.realModel !== undefined) update.realModel = patch.realModel;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.inputPrice !== undefined) update.inputPrice = String(patch.inputPrice);
  if (patch.outputPrice !== undefined) update.outputPrice = String(patch.outputPrice);
  if (patch.cacheInputPrice !== undefined) update.cacheInputPrice = String(patch.cacheInputPrice);
  if (patch.isFree !== undefined) update.isFree = patch.isFree;
  if (patch.contextLength !== undefined) update.contextLength = patch.contextLength;
  if (patch.fallbackModels !== undefined) update.fallbackModels = patch.fallbackModels;
  if (patch.paramRules !== undefined) update.paramRules = patch.paramRules;
  if (patch.billingPolicy !== undefined) update.billingPolicy = patch.billingPolicy;
  if (patch.rpmLimit !== undefined) update.rpmLimit = patch.rpmLimit;
  if (patch.tpmLimit !== undefined) update.tpmLimit = patch.tpmLimit;
  const [updated] = await s.db
    .update(modelMappings)
    .set(update)
    .where(eq(modelMappings.id, id))
    .returning();
  if (!updated) throw new HttpError('MODEL_NOT_FOUND', '模型不存在');
  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'model.update',
    targetType: 'model',
    targetId: id,
    // 改价直接影响计费——审计必须可查到改了什么
    detail: { ...patch },
  });
  return updated;
}

/** 删除 = 软退场（status=1），历史调用记录引用不受影响 */
export async function retireModel(s: AdminServices, id: number, adminId: number): Promise<void> {
  const [retired] = await s.db
    .update(modelMappings)
    .set({ status: 1, updatedAt: new Date() })
    .where(eq(modelMappings.id, id))
    .returning({ id: modelMappings.id });
  if (!retired) throw new HttpError('MODEL_NOT_FOUND', '模型不存在');
  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'model.retire',
    targetType: 'model',
    targetId: id,
  });
}

export async function listModels(s: AdminServices, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [modelMappings.externalName, modelMappings.realModel],
    sort: {
      by: {
        id: modelMappings.id,
        externalName: modelMappings.externalName,
        realModel: modelMappings.realModel,
        status: modelMappings.status,
        createdAt: modelMappings.createdAt,
      },
      fallback: 'createdAt',
      tiebreaker: modelMappings.id,
    },
  });
  const result = await paginateQuery(
    page,
    s.db.select().from(modelMappings).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    countAll(s.db, modelMappings, where),
  );
  // 只查当页模型的渠道绑定（分页后 inArray 限定）
  const pageIds = result.list.map((r) => r.id);
  const bindings = pageIds.length
    ? await s.db.select().from(modelChannels).where(inArray(modelChannels.mappingId, pageIds))
    : [];
  const channelIdsByModel = new Map<number, number[]>();
  for (const b of bindings) {
    const arr = channelIdsByModel.get(b.mappingId) ?? [];
    arr.push(b.channelId);
    channelIdsByModel.set(b.mappingId, arr);
  }
  const list = result.list.map((r) => ({ ...r, channelIds: channelIdsByModel.get(r.id) ?? [] }));
  return { ...result, list };
}
