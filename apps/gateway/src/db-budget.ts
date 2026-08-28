/**
 * gateway DB 并发预算推导（F-6 红队复审 R-3）：
 * 池充足时留 32 余量给 fire-and-forget 日志与旁路；小池下限 8 保最低吞吐，
 * 但预算绝不允许越过「池容量 − 2」——预算门反超池 = 门自己制造检出排队
 * （node 池队列塌吞吐 / Bun SQL 楔死，FINDINGS F-6）。池小到预算放不进池内
 * （< 2，连 1 并发都无余量）才 fail-fast；小池压力形态（如 e2e 池 2）按
 * 公式收敛到 limit=1，不拒绝。
 */
import type { DbBudgetOptions } from '@tillgate/http';

/** 预算下限：池充足时的最低业务并发（低于此吞吐不可用） */
const MIN_LIMIT = 8;
/** 池内必须保留的非业务连接余量（fire-and-forget/探针旁路的最小面） */
const POOL_HEADROOM = 2;
/** 池充足时的目标余量（fire-and-forget 日志 + 旁路 DB 工作） */
const TARGET_MARGIN = 32;

export function gatewayDbBudget(poolMax: number): DbBudgetOptions {
  if (poolMax < 2) {
    throw new Error(
      `gateway DB_POOL_MAX must be >= 2 (got ${poolMax}): ` +
        'budget of 1 already leaves zero pool headroom',
    );
  }
  return {
    limit: Math.max(
      1,
      Math.min(Math.max(MIN_LIMIT, poolMax - TARGET_MARGIN), poolMax - POOL_HEADROOM),
    ),
    maxQueue: 20_000,
    waitTimeoutMs: 120_000,
  };
}
