/**
 * settlement/effects：worker 的 Redis 提交后效应（缓存失效 + TPM 回填）。
 * Redis 只承载投影，不参与资金事务（资金事实在 PostgreSQL/wallet）。
 */
import type { Redis } from 'ioredis';
import type { BillingEffects } from '../billing/types.js';
import { backfillTpm } from './tpm-backfill.js';

export function createRedisBillingEffects(redis: Redis): BillingEffects {
  return {
    async balanceChanged({ userId }) {
      await redis.del(`billing:balance:${userId}`);
    },
    async usageSettled({ data }) {
      await backfillTpm(redis, data);
    },
  };
}
