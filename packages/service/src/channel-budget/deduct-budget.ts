/** 结算收尾②：按真实上游成本扣减进货额度；余额 ≤ 阈值 → 熔断（返回 true）。 */
import type { DbTx } from '@ai-gateway/repository';
import { createRepositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import type { ChannelBudgetEnv } from './env.js';

export function createDeductBudget(env: ChannelBudgetEnv) {
  const clock = env.clock ?? (() => new Date());
  const repos = env.repos ?? createRepositories();

  return async function deductBudget(
    ctx: RunContext,
    tx: DbTx,
    input: { channelId: number | null; upstreamCost: string },
  ): Promise<boolean> {
    if (input.channelId == null) return false;
    return repos.channel.deductBudgetAndMaybeBreak(inTx(ctx, tx), {
      channelId: input.channelId,
      upstreamCost: input.upstreamCost,
      now: clock(),
    });
  };
}

export type DeductBudget = ReturnType<typeof createDeductBudget>;
