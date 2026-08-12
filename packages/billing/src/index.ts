/**
 * @ai-gateway/billing — 余额变更/资金流水/审计写入/路由缓存失效。
 *
 * 资损关键逻辑集中于此，client-api 与 admin-api 共用，避免双写漂移导致资损。
 * balance.ts 的原子条件 UPDATE / 缓存键名 / Decimal 计算为资损核心，不可随意改动。
 */

// 余额变更 + 资金流水 + 坏账解冻
export {
  changeBalance,
  recordTransaction,
  unfreezeIfBadDebt,
  type BalanceChangeResult,
} from './balance.js';

// 审计写入（adminId 引用 admins.id）
export { recordAudit } from './audit.js';

// 共享 Redis 单例
export { getSharedRedis, setRedisForTest } from './redis.js';

// 路由缓存失效（bump gateway 版本）
export { invalidateRouteCache } from './route-cache.js';
