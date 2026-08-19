/** 结算收尾①：释放本请求预留的敞口（billing settle 同事务调用）。 */
import type { DbTx } from '@ai-gateway/repository';
import { createRepositories } from '@ai-gateway/repository';
import { ChannelExposureInvariantError } from '@ai-gateway/domain';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import type { ChannelBudgetEnv } from './env.js';

export function createReleaseExposure(env: ChannelBudgetEnv) {
  const clock = env.clock ?? (() => new Date());
  const repos = env.repos ?? createRepositories();

  return async function releaseExposure(
    ctx: RunContext,
    tx: DbTx,
    input: { channelId: number | null; channelReservedAmount: string | null },
  ): Promise<void> {
    if (input.channelId == null || input.channelReservedAmount == null) return;
    const c = inTx(ctx, tx);
    const released = await repos.channel.tryDecreaseReserved(c, {
      channelId: input.channelId,
      amount: input.channelReservedAmount,
      now: clock(),
    });
    if (!released) {
      throw new ChannelExposureInvariantError(
        `release ${input.channelReservedAmount} on channel ${input.channelId}`,
      );
    }
  };
}

export type ReleaseExposure = ReturnType<typeof createReleaseExposure>;
