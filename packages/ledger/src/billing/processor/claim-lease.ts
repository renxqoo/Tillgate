import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import type { SettlementClaim, SettlementProcessorOptions } from '../types.js';

/**
 * 认领租约保活（拆自 runOnce，行为零变更）：settlement 期间周期性续 claim_until，
 * 防止长事务结算中被 recoverOnce 判定「认领过期」而重排队（双扣风险）。
 *
 * 纯基础设施——与结算业务无关：串行合并的 renewal promise 链（防并发续租
 * 乱序）+ setInterval(unref) + finally 保证退出前最后一次续租落定。
 * 续租失败静默（.catch noop）：租约过期兜底在 recoverOnce③，这里只是尽力保活。
 */
export async function withClaimRenewal<T>(
  db: Db,
  options: SettlementProcessorOptions,
  claims: SettlementClaim[],
  fn: () => Promise<T>,
): Promise<T> {
  let renewal: Promise<void> = Promise.resolve();
  const renew = (): void => {
    renewal = renewal
      .then(async () => {
        const tokens = claims.map((item) => item.claimToken);
        if (tokens.length === 0) return;
        await db.execute(sql`
          update billing_requests
          set claim_until = clock_timestamp() + (${options.claimLeaseMs} * interval '1 millisecond'),
              updated_at = clock_timestamp()
          where status = 'processing'
            and claim_owner = ${options.ownerId}
            and claim_token in (${sql.join(
              tokens.map((token) => sql`${token}::uuid`),
              sql`, `,
            )})
            and claim_until > clock_timestamp()
        `);
      })
      .catch(() => {});
  };
  const heartbeat = setInterval(renew, Math.max(250, Math.floor(options.claimLeaseMs / 3)));
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
}
