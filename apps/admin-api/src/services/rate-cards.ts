import { eq } from 'drizzle-orm';
import { rateCards, rateCardCoefficients } from '@ai-gateway/db/schema';
import { HttpError, recordAudit } from '@ai-gateway/http';
import type { AdminServices } from './index.js';

/**
 * 费率卡服务（api-contract §4.9）。
 *
 * 定价模型：用户价 = 官方价（model_mappings）× 费率卡系数。
 * 不变量（data-model §3.9）：每张卡必有且仅有一行 scope=global 兜底系数，
 * 创建卡与建 global 系数行在同一事务提交。
 */

export const RATE_CARD_NOT_FOUND = new HttpError(404, 'RATE_CARD_NOT_FOUND', '费率卡不存在');

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
      // 更新 global 系数行
      await tx
        .update(rateCardCoefficients)
        .set({ coefficient: fmtCoeff(patch.coefficient) })
        .where(eq(rateCardCoefficients.rateCardId, id));
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
