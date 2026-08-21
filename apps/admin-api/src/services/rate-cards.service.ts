/**
 * 费率卡管理服务：建卡（全局兜底系数同拍落库）/ 更新 / 删除 / 卡内用户 / 健康自检。
 *
 * 用户价 = 官方价（model_mappings）× 系数；系数解析优先级 model > group > global
 * （resolver 在 ledger）。因此：
 *   - 全局系数 PATCH 只触碰 scope='global' 行（model/group 覆写行隔离）
 *   - 删除前置：无用户绑定（users.rateCardId）→ 409 rate_card_in_use
 *   - 系数恒 3 位小数（numeric(6,3)，上限 9.999）
 */
import { recordAudit } from '@ai-gateway/http';
import { Decimal } from '@ai-gateway/domain';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories, type RateCardRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { ListQueryParts } from '../http/list-query.js';

export const RATE_CARD_SORTS = ['id', 'name', 'status', 'createdAt'] as const;
export const RATE_CARD_USER_SORTS = ['id', 'subject', 'createdAt'] as const;

/** 系数落库/回显口径：3 位小数字符串（numeric(6,3)） */
export const formatCoefficient = (v: string): string => new Decimal(v).toFixed(3);

export interface RateCardsServiceDeps {
  db: Db;
  repos?: Repositories;
}

export interface RateCardsService {
  list(
    ctx: RunContext,
    query: ListQueryParts,
  ): Promise<{ rows: Array<RateCardRow & { coefficient: string }>; total: number; page: number; pageSize: number }>;
  create(
    ctx: RunContext,
    input: { adminId: number; name: string; description?: string; coefficient: string },
  ): Promise<{ id: number; name: string; coefficient: string }>;
  update(
    ctx: RunContext,
    input: { adminId: number; rateCardId: number; patch: { name?: string; description?: string | null; status?: number; coefficient?: string } },
  ): Promise<{ id: number; name: string; coefficient?: string }>;
  remove(ctx: RunContext, input: { adminId: number; rateCardId: number }): Promise<{ ok: true }>;
  listUsers(
    ctx: RunContext,
    input: { rateCardId: number; query: ListQueryParts },
  ): Promise<{ rows: Array<{ id: number; subject: string; email: string | null; displayName: string | null }>; total: number; page: number; pageSize: number }>;
  /** 数据模型 §3.9 自检：每卡恰一全局兜底行 */
  health(ctx: RunContext, rateCardId: number): Promise<{ hasGlobalCoefficient: boolean; coefficient: string | null }>;
}

export function createRateCardsService(deps: RateCardsServiceDeps): RateCardsService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();

  return {
    async list(ctx, query) {
      const result = await repos.rateCard.list({ db, ...ctx }, {
        q: query.q,
        sortBy: query.sortBy as (typeof RATE_CARD_SORTS)[number],
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      });
      return {
        rows: result.rows.map((row) => ({ ...row, coefficient: row.globalCoefficient ?? '1.000' })),
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async create(ctx, input) {
      const card = await db.transaction(async (tx) =>
        repos.rateCard.insertWithGlobal({ db: tx, ...ctx }, {
          name: input.name,
          description: input.description ?? null,
          coefficient: formatCoefficient(input.coefficient),
        }),
      );
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'rate_card.create',
        targetType: 'rate_card',
        targetId: card.id,
        detail: { name: card.name, coefficient: formatCoefficient(input.coefficient) },
      });
      return { id: card.id, name: card.name, coefficient: formatCoefficient(input.coefficient) };
    },

    async update(ctx, input) {
      // coefficient 是系数行的列（scope='global' 行），不能混进卡面 patch
      const { coefficient, ...cardPatch } = input.patch;
      const row = await db.transaction(async (tx) =>
        repos.rateCard.updateWithGlobal({ db: tx, ...ctx }, {
          rateCardId: input.rateCardId,
          patch: cardPatch,
          globalCoefficient: coefficient !== undefined ? formatCoefficient(coefficient) : undefined,
        }),
      );
      if (!row) throw new AppError(404, 'rate_card_not_found', 'Rate card not found');
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'rate_card.update',
        targetType: 'rate_card',
        targetId: row.id,
        detail: { patch: input.patch },
      });
      return {
        id: row.id,
        name: row.name,
        ...(input.patch.coefficient !== undefined
          ? { coefficient: formatCoefficient(input.patch.coefficient) }
          : {}),
      };
    },

    async remove(ctx, input) {
      const bound = await repos.rateCard.countBoundUsers({ db, ...ctx }, input.rateCardId);
      if (bound > 0) {
        throw new AppError(409, 'rate_card_in_use', 'Rate card still has bound users and cannot be deleted (migrate users first)');
      }
      const ok = await db.transaction(async (tx) =>
        repos.rateCard.deleteCard({ db: tx, ...ctx }, { rateCardId: input.rateCardId }),
      );
      if (!ok) throw new AppError(404, 'rate_card_not_found', 'Rate card not found');
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'rate_card.delete',
        targetType: 'rate_card',
        targetId: input.rateCardId,
      });
      return { ok: true as const };
    },

    async listUsers(ctx, input) {
      const result = await repos.rateCard.listCardUsers({ db, ...ctx }, {
        rateCardId: input.rateCardId,
        q: input.query.q,
        sortBy: input.query.sortBy as (typeof RATE_CARD_USER_SORTS)[number],
        order: input.query.order,
        limit: input.query.limit,
        offset: input.query.offset,
      });
      return {
        rows: result.rows,
        total: result.total,
        page: input.query.page,
        pageSize: input.query.pageSize,
      };
    },

    async health(ctx, rateCardId) {
      const card = await repos.rateCard.findById({ db, ...ctx }, rateCardId);
      if (!card) throw new AppError(404, 'rate_card_not_found', 'Rate card not found');
      const coefficient = await repos.rateCard.findGlobalCoefficient({ db, ...ctx }, rateCardId);
      return { hasGlobalCoefficient: coefficient != null, coefficient };
    },
  };
}
