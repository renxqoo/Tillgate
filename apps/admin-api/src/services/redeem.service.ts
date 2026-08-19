/**
 * 兑换码批次服务：批次创建（明文码仅此一次返回；库内唯一落 SHA-256）/
 * 批次列表与详情 / 批内码列表（哈希脱敏）/ 单码作废（CAS 0→2）。
 * 面额不可变——改价 = 新批次。
 */
import { recordAudit, generateRedeemCode, sha256Hex } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories, type RedeemBatchRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { ListQueryParts } from '../http/list-query.js';

export const BATCH_SORTS = ['id', 'name', 'amount', 'createdAt'] as const;
export const CODE_SORTS = ['id', 'usedAt'] as const;

export interface RedeemServiceDeps {
  db: Db;
  repos?: Repositories;
}

export interface RedeemService {
  createBatch(
    ctx: RunContext,
    input: {
      adminId: number;
      name: string;
      remark?: string | null;
      amount: string;
      count: number;
      expiresAt?: Date | null;
    },
  ): Promise<{ batch: { id: number; name: string; amount: string; total: number }; codes: string[] }>;
  list(ctx: RunContext, query: ListQueryParts): Promise<{ rows: RedeemBatchRow[]; total: number; page: number; pageSize: number }>;
  detail(ctx: RunContext, batchId: number): Promise<RedeemBatchRow>;
  listCodes(
    ctx: RunContext,
    input: { batchId: number; status?: number; query: ListQueryParts },
  ): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }>;
  revokeCode(ctx: RunContext, input: { adminId: number; codeId: number }): Promise<{ ok: true }>;
}

export function createRedeemService(deps: RedeemServiceDeps): RedeemService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();

  return {
    async createBatch(ctx, input) {
      // 明文在内存生成；库内只落哈希（code_hash 唯一索引）
      const plaintexts = Array.from({ length: input.count }, () => generateRedeemCode());
      const result = await db.transaction(async (tx) =>
        repos.redeemBatch.insertBatchWithCodes({ db: tx, ...ctx }, {
          name: input.name,
          remark: input.remark ?? null,
          amount: input.amount,
          total: input.count,
          createdBy: input.adminId,
          codes: plaintexts.map((plaintext) => ({
            codeHash: sha256Hex(plaintext),
            expiresAt: input.expiresAt ?? null,
          })),
        }),
      );
      const batch = await repos.redeemBatch.findBatch({ db, ...ctx }, result.batchId);
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'redeem_batch.create',
        targetType: 'redeem_batch',
        targetId: result.batchId,
        detail: { name: input.name, amount: input.amount, count: input.count },
      });
      return {
        batch: {
          id: result.batchId,
          name: batch!.name,
          amount: batch!.amount,
          total: batch!.total,
        },
        codes: plaintexts,
      };
    },

    async list(ctx, query) {
      const result = await repos.redeemBatch.listBatches({ db, ...ctx }, {
        q: query.q,
        sortBy: query.sortBy as (typeof BATCH_SORTS)[number],
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      });
      return { rows: result.rows, total: result.total, page: query.page, pageSize: query.pageSize };
    },

    async detail(ctx, batchId) {
      const batch = await repos.redeemBatch.findBatch({ db, ...ctx }, batchId);
      if (!batch) throw new AppError(404, 'redeem_batch_not_found', '兑换批次不存在');
      return batch;
    },

    async listCodes(ctx, input) {
      const batch = await repos.redeemBatch.findBatch({ db, ...ctx }, input.batchId);
      if (!batch) throw new AppError(404, 'redeem_batch_not_found', '兑换批次不存在');
      const result = await repos.redeemBatch.listCodes({ db, ...ctx }, {
        batchId: input.batchId,
        status: input.status,
        sortBy: input.query.sortBy as (typeof CODE_SORTS)[number],
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

    async revokeCode(ctx, input) {
      // CAS 0→2：已用/已作废/不存在统一 404（不泄漏状态差异）
      const revoked = await repos.redeemBatch.revokeCode({ db, ...ctx }, { codeId: input.codeId });
      if (!revoked) throw new AppError(404, 'redeem_code_not_found', '兑换码不存在或已使用/已作废');
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'redeem_code.revoke',
        targetType: 'redeem_code',
        targetId: input.codeId,
      });
      return { ok: true as const };
    },
  };
}
