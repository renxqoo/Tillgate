import { and, eq } from 'drizzle-orm';
import { rateCards, rateCardCoefficients, users } from '@ai-gateway/db/schema';
import { buildList, countAll, HttpError, listQuerySchema, paginateQuery, recordAudit } from '@ai-gateway/http';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdminServices } from './index.js';
import { enrichWithWallet } from './users.js';

/**
 * 费率卡服务（api-contract §4.9）。
 *
 * 定价模型：用户价 = 官方价（model_mappings）× 费率卡系数。
 * 不变量（data-model §3.9）：每张卡必有且仅有一行 scope=global 兜底系数，
 * 创建卡与建 global 系数行在同一事务提交。
 */

export const RATE_CARD_NOT_FOUND = new HttpError('RATE_CARD_NOT_FOUND', '费率卡不存在');

/** 系数保留 3 位小数的字符串（numeric(6,3) 列） */
export function fmtCoeff(v: number): string {
  return v.toFixed(3);
}

export interface RateCardCreate {
  name: string;
  description?: string;
  /** 全局兜底系数 [0, 9.999] */
  coefficient: number;
}

export type RateCardPatch = {
  name?: string;
  description?: string | null;
  /** 0 启用 / 1 停用 */
  status?: number;
  coefficient?: number;
}

export async function createRateCard(
  s: AdminServices,
  input: RateCardCreate,
  adminId: number,
): Promise<{ id: number; name: string; description: string | null; status: number }> {
  const card = await s.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(rateCards)
      .values({ name: input.name, description: input.description ?? null, status: 0 })
      .returning();
    await tx.insert(rateCardCoefficients).values({
      rateCardId: created!.id,
      scope: 'global',
      coefficient: fmtCoeff(input.coefficient),
    });
    return created!;
  });

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'rate_card.create',
    targetType: 'rate_card',
    targetId: card.id,
    detail: { name: input.name, coefficient: input.coefficient },
  });
  return card;
}

export async function updateRateCard(
  s: AdminServices,
  id: number,
  patch: RateCardPatch,
  adminId: number,
): Promise<{ id: number; name: string }> {
  const result = await s.db.transaction(async (tx) => {
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.status !== undefined) update.status = patch.status;
    const [updated] = await tx
      .update(rateCards)
      .set(update)
      .where(eq(rateCards.id, id))
      .returning({ id: rateCards.id, name: rateCards.name });
    if (!updated) return null;
    if (patch.coefficient !== undefined) {
      // 更新 global 兜底系数行——必须限定 scope=global：
      // schema 支持 model/group 级覆盖行（uq (rateCardId, scope, modelMappingId)），
      // 无 scope 过滤会把模型级系数一并拍平（定价静默漂移）
      await tx
        .update(rateCardCoefficients)
        .set({ coefficient: fmtCoeff(patch.coefficient) })
        .where(
          and(eq(rateCardCoefficients.rateCardId, id), eq(rateCardCoefficients.scope, 'global')),
        );
    }
    return updated;
  });
  if (!result) throw RATE_CARD_NOT_FOUND;

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'rate_card.update',
    targetType: 'rate_card',
    targetId: id,
    detail: patch,
  });
  return result;
}

/** 删除：仅当无用户绑定时允许（防误删导致账户孤儿；系数行一并清理） */
export async function deleteRateCard(s: AdminServices, id: number, adminId: number): Promise<void> {
  const bound = await s.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.rateCardId, id))
    .limit(1);
  if (bound.length > 0) {
    throw new HttpError('RATE_CARD_IN_USE', '该费率卡仍有用户绑定，无法删除（请先迁移用户）');
  }
  await s.db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, id));
  const result = await s.db
    .delete(rateCards)
    .where(eq(rateCards.id, id))
    .returning({ id: rateCards.id });
  if (result.length === 0) throw RATE_CARD_NOT_FOUND;
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'rate_card.delete',
    targetType: 'rate_card',
    targetId: id,
  });
}

export async function listRateCards(s: AdminServices, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [rateCards.name, rateCards.description],
    sort: {
      by: { id: rateCards.id, name: rateCards.name, status: rateCards.status, createdAt: rateCards.createdAt },
      fallback: 'createdAt',
      tiebreaker: rateCards.id,
    },
  });
  const result = await paginateQuery(
    page,
    s.db
      .select({
        id: rateCards.id,
        name: rateCards.name,
        description: rateCards.description,
        status: rateCards.status,
        createdAt: rateCards.createdAt,
        updatedAt: rateCards.updatedAt,
      })
      .from(rateCards)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, rateCards, where),
  );
  const ids = result.list.map((r) => r.id);
  const coeffs = ids.length
    ? await s.db
        .select({
          rateCardId: rateCardCoefficients.rateCardId,
          coefficient: rateCardCoefficients.coefficient,
        })
        .from(rateCardCoefficients)
        .where(eq(rateCardCoefficients.scope, 'global'))
    : [];
  const coeffMap = new Map(coeffs.map((x) => [x.rateCardId, x.coefficient]));
  const list = result.list.map((r) => ({ ...r, coefficient: coeffMap.get(r.id) ?? '1.000' }));
  return { ...result, list };
}

/** 查看绑定该卡的账户（api-contract §4.9；S7：资金读数走 wallet 契约） */
export async function listRateCardUsers(s: AdminServices, id: number, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [users.subject, users.displayName, users.email],
    conditions: [eq(users.rateCardId, id)],
    sort: {
      by: { id: users.id, subject: users.subject, createdAt: users.createdAt },
      fallback: 'createdAt',
      tiebreaker: users.id,
    },
  });
  const result = await paginateQuery(
    page,
    s.db
      .select({
        id: users.id,
        subject: users.subject,
        displayName: users.displayName,
        email: users.email,
        status: users.status,
      })
      .from(users)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, users, where),
  );
  // 资金读数富集（wallet 单一事实源）
  await enrichWithWallet(s, result.list as Array<Record<string, unknown> & { id: number }>);
  return result;
}

/** 健康自检：全局系数行是否存在（data-model §3.9 约束校验） */
export async function rateCardHealth(s: AdminServices, id: number) {
  const globalRow = await s.db
    .select({ coefficient: rateCardCoefficients.coefficient })
    .from(rateCardCoefficients)
    .where(
      sql`${rateCardCoefficients.rateCardId} = ${id} and ${rateCardCoefficients.scope} = 'global'`,
    )
    .limit(1);
  return {
    hasGlobalCoefficient: globalRow.length === 1,
    coefficient: globalRow[0]?.coefficient ?? null,
  };
}
