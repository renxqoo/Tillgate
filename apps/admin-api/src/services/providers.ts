import { eq } from 'drizzle-orm';
import { providers } from '@ai-gateway/db/schema';
import { buildList, bumpRouteCache, countAll, HttpError, listQuerySchema, paginateQuery, recordAudit } from '@ai-gateway/http';
import { z } from 'zod';
import type { AdminServices } from './index.js';

/**
 * 供应商服务（api-contract §4.6）。
 * 变更后 bump 路由缓存版本，gateway 检测版本变化后重建路由表。
 */

export interface ProviderCreateInput {
  name: string;
  baseUrl: string;
  protocol?: string;
  status?: number;
}

export interface ProviderPatch {
  name?: string;
  baseUrl?: string;
  protocol?: string;
  status?: number;
}

export async function createProvider(
  s: AdminServices,
  input: ProviderCreateInput,
  adminId: number,
): Promise<typeof providers.$inferSelect> {
  const [created] = await s.db
    .insert(providers)
    .values({
      name: input.name,
      protocol: input.protocol ?? 'openai-compatible',
      baseUrl: input.baseUrl,
      status: input.status ?? 0,
    })
    .returning();
  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'provider.create',
    targetType: 'provider',
    targetId: created!.id,
    detail: { name: input.name },
  });
  return created!;
}

export async function updateProvider(
  s: AdminServices,
  id: number,
  patch: ProviderPatch,
  adminId: number,
): Promise<typeof providers.$inferSelect> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.baseUrl !== undefined) update.baseUrl = patch.baseUrl;
  if (patch.protocol !== undefined) update.protocol = patch.protocol;
  if (patch.status !== undefined) update.status = patch.status;
  const [updated] = await s.db
    .update(providers)
    .set(update)
    .where(eq(providers.id, id))
    .returning();
  if (!updated) throw new HttpError('PROVIDER_NOT_FOUND', '供应商不存在');
  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'provider.update',
    targetType: 'provider',
    targetId: id,
    detail: { ...patch },
  });
  return updated;
}

/** 删除 = 软退场（status=1），历史渠道引用不受影响 */
export async function retireProvider(s: AdminServices, id: number, adminId: number): Promise<void> {
  const [retired] = await s.db
    .update(providers)
    .set({ status: 1 })
    .where(eq(providers.id, id))
    .returning({ id: providers.id });
  if (!retired) throw new HttpError('PROVIDER_NOT_FOUND', '供应商不存在');
  await bumpRouteCache(s.redis);
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'provider.retire',
    targetType: 'provider',
    targetId: id,
  });
}

export async function listProviders(s: AdminServices, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [providers.name, providers.baseUrl],
    sort: {
      by: { id: providers.id, name: providers.name, status: providers.status, createdAt: providers.createdAt },
      fallback: 'createdAt',
      tiebreaker: providers.id,
    },
  });
  return paginateQuery(
    page,
    s.db.select().from(providers).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    countAll(s.db, providers, where),
  );
}
