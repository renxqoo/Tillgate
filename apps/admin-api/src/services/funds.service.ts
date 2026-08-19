/**
 * 用户资金管理服务：调账（正负）/ 赠送——幂等走 operations 用例
 * （operationId + 指纹；同键同参重放回执、异参 409）。
 * 资金动词来自 wallet：正数 credit；负数 transfer 到外部世界镜像
 * （allowCredit:true——授信地板内可扣到负，地板由 wallet 守卫）。
 */
import { createOperationsUseCase, type WalletApi } from '@ai-gateway/service';
import type { RunContext } from '@ai-gateway/service';
import { Decimal } from '@ai-gateway/domain';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import { AppError } from '../http/error-map.js';

export interface FundsServiceDeps {
  db: Db;
  repos?: Repositories;
  wallet: Pick<WalletApi, 'credit' | 'transfer'>;
}

export interface FundsReceipt {
  ok: true;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

export interface FundsService {
  /** 调账：amount 可正可负（≠0，|amount| ≤ 1e9 由路由 zod 收口） */
  adjust(
    ctx: RunContext,
    input: { adminId: number; userId: number; amount: string; remark?: string | null; operationId: string },
  ): Promise<FundsReceipt>;
  /** 赠送：恒正数入账 */
  gift(
    ctx: RunContext,
    input: { adminId: number; userId: number; amount: string; remark?: string | null; operationId: string },
  ): Promise<FundsReceipt>;
}

const OUTSIDE_ACCOUNT = 'outside';

export function createFundsService(deps: FundsServiceDeps): FundsService {
  const { db, wallet } = deps;
  const repos = deps.repos ?? createRepositories();
  const operations = createOperationsUseCase({ db, repos });

  async function assertUser(userId: number, ctx: RunContext): Promise<void> {
    const exists = await repos.user.userExists({ db, ...ctx }, userId);
    if (!exists) throw new AppError(404, 'user_not_found', '用户不存在');
  }

  /** 资金审计与业务同事务（与 billing-review 同口径）——审计是运营复核的主观察面，
   *  事后由 fund_operations.payload 反推等于把关键资金动作藏进暗处 */
  async function auditInTx(
    tx: Parameters<Parameters<typeof operations.run>[1]['execute']>[0],
    ctx: RunContext,
    input: { adminId: number; action: string; userId: number; amount: string; remark: string | null; operationId: string; result: Record<string, unknown> },
  ): Promise<void> {
    await repos.auditLog.insert({ db: tx, ...ctx }, {
      adminId: input.adminId,
      actor: 'admin',
      action: input.action,
      targetType: 'user',
      targetId: String(input.userId),
      detail: {
        amount: input.amount,
        remark: input.remark,
        operationId: input.operationId,
        ...input.result,
      },
    });
  }

  async function credit(
    kind: 'admin.adjust' | 'admin.gift',
    ctx: RunContext,
    input: { adminId: number; userId: number; amount: string; remark: string | null; operationId: string },
  ): Promise<FundsReceipt> {
    await assertUser(input.userId, ctx);
    const { receipt, replayed } = await operations.run(ctx, {
      operationId: input.operationId,
      kind,
      payload: { kind, userId: input.userId, amount: input.amount, adminId: input.adminId, remark: input.remark },
      execute: async (tx) => {
        const posted = await wallet.credit(ctx, {
          userId: input.userId,
          amount: input.amount,
          refType: 'admin',
          refId: input.operationId,
          memo: input.remark ?? undefined,
          tx,
        });
        const result = {
          balanceBefore: new Decimal(posted.balanceAfter).minus(input.amount).toString(),
          balanceAfter: posted.balanceAfter,
        };
        await auditInTx(tx, ctx, { adminId: input.adminId, action: kind, userId: input.userId, amount: input.amount, remark: input.remark, operationId: input.operationId, result });
        return result;
      },
    });
    return { ok: true, balanceBefore: receipt.balanceBefore, balanceAfter: receipt.balanceAfter, replayed };
  }

  return {
    async adjust(ctx, input) {
      await assertUser(input.userId, ctx);
      const { receipt, replayed } = await operations.run(ctx, {
        operationId: input.operationId,
        kind: 'admin.adjust',
        payload: { kind: 'admin.adjust', userId: input.userId, amount: input.amount, adminId: input.adminId, remark: input.remark ?? null },
        execute: async (tx) => {
          // 负数调账 = 扣款到外部世界镜像（授信地板内可负，地板由 wallet 守卫）
          if (input.amount.startsWith('-')) {
            const posted = await wallet.transfer(ctx, {
              from: { userId: input.userId },
              to: { code: OUTSIDE_ACCOUNT },
              amount: input.amount.slice(1),
              refType: 'admin',
              refId: input.operationId,
              memo: input.remark ?? undefined,
              allowCredit: true,
              tx,
            });
            const result = {
              balanceBefore: new Decimal(posted.fromBalanceAfter).plus(input.amount.slice(1)).toString(),
              balanceAfter: posted.fromBalanceAfter,
            };
            await auditInTx(tx, ctx, { adminId: input.adminId, action: 'admin.adjust', userId: input.userId, amount: input.amount, remark: input.remark ?? null, operationId: input.operationId, result });
            return result;
          }
          const posted = await wallet.credit(ctx, {
            userId: input.userId,
            amount: input.amount,
            refType: 'admin',
            refId: input.operationId,
            memo: input.remark ?? undefined,
            tx,
          });
          const result = {
            balanceBefore: new Decimal(posted.balanceAfter).minus(input.amount).toString(),
            balanceAfter: posted.balanceAfter,
          };
          await auditInTx(tx, ctx, { adminId: input.adminId, action: 'admin.adjust', userId: input.userId, amount: input.amount, remark: input.remark ?? null, operationId: input.operationId, result });
          return result;
        },
      });
      return { ok: true, balanceBefore: receipt.balanceBefore, balanceAfter: receipt.balanceAfter, replayed };
    },

    async gift(ctx, input) {
      return credit('admin.gift', ctx, { ...input, remark: input.remark ?? '管理员赠送' });
    },
  };
}
