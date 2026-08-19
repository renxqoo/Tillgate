/**
 * 兑换码服务：核销与入账一个事务（claim CAS 抢占 + wallet.credit 腿级入账）
 * + 兑换频率闸（防暴力猜码）+ 已兑换历史。
 * 资损不变量：
 *   - 同码并发核销只有 claim 赢家入账一次（CAS status=0→1）
 *   - 入账幂等锚 refType='redeem' + refId=`code:{id}`（重放/补发结构性安全）
 *   - claim 与 credit 同事务：入账失败则核销一并回滚（码可重试，账不落空）
 */
import { sha256Hex } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext, WalletApi } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { FixedWindowCounter } from './rate-counter.js';

export interface RedeemServiceDeps {
  db: Db;
  wallet: WalletApi;
  repos?: Repositories;
  /** 兑换频率闸（per-user 固定窗口；Redis 计数器——hit 失败 fail-closed 503） */
  limiter: FixedWindowCounter;
  /** 每分钟兑换次数上限 */
  perMinuteLimit: number;
  clock?: () => Date;
}

export interface RedeemService {
  redeem(
    ctx: RunContext,
    userId: number,
    input: { code: string },
  ): Promise<{ amount: string; balanceAfter: string; transactionId: number }>;
  history(
    ctx: RunContext,
    userId: number,
    input: { page: number; limit: number },
  ): Promise<Array<{ codeId: number; batchName: string; amount: string; usedAt: Date | null }>>;
}

export function createRedeemService(deps: RedeemServiceDeps): RedeemService {
  const { db, wallet } = deps;
  const repos = deps.repos ?? createRepositories();
  const clock = deps.clock ?? (() => new Date());

  return {
    async redeem(ctx, userId, input) {
      const code = input.code.trim();
      if (!code) throw new AppError(400, 'invalid_code', '兑换码不能为空');

      // 频率闸：先记数（每次尝试都计入配额——猜码攻击本身就该被计数）
      // limiter.hit 失败 = Redis 不可达 → fail-closed 拒绝（防护组件不可用不裸奔）
      let n: number;
      try {
        n = await deps.limiter.hit(`redeem:${userId}`, 60);
      } catch {
        throw new AppError(503, 'rate_counter_unavailable', '频率计数器不可用，请稍后再试');
      }
      if (n > deps.perMinuteLimit) {
        throw new AppError(429, 'redeem_rate_limited', '兑换过于频繁，请稍后再试');
      }

      const codeHash = sha256Hex(code);
      const runCtx: RunContext = { ...ctx, actor: { kind: 'user', id: userId } };

      const result = await db.transaction(async (tx) => {
        const c = { db: tx, ...runCtx };
        const claim = await repos.redeemCode.claim(c, { codeHash, userId, now: clock() });
        if (!claim) {
          // 抢占失败 → 区分错误语义（无效 / 已用 / 过期）
          const row = await repos.redeemCode.findByCodeHash(c, codeHash);
          if (!row) throw new AppError(404, 'invalid_code', '兑换码无效');
          // v1 对位：区分「已使用」与「已吊销」（运营撤回的码语义不同）
          if (row.status === 2) throw new AppError(409, 'code_revoked', '兑换码已被撤销');
          if (row.status !== 0) throw new AppError(409, 'code_already_used', '兑换码已被使用');
          throw new AppError(410, 'code_expired', '兑换码已过期');
        }
        const credited = await wallet.credit(runCtx, {
          userId,
          amount: claim.amount,
          refType: 'redeem',
          refId: `code:${claim.codeId}`,
          memo: `兑换码入账（批次 ${claim.batchId}）`,
          tx,
        });
        return credited;
      });

      return {
        amount: result.amount,
        balanceAfter: result.balanceAfter,
        transactionId: result.transactionId,
      };
    },

    async history(ctx, userId, input) {
      const runCtx: RunContext = { ...ctx, actor: { kind: 'user', id: userId } };
      return repos.redeemCode.listRedeemedByUser({ db, ...runCtx }, {
        userId,
        limit: input.limit,
        offset: (input.page - 1) * input.limit,
      });
    },
  };
}
