/**
 * 装配子入口(内部 workspace 契约,非公开 API——总纲 §5.3):
 * 可替换存储契约与装配面 port 类型在此导出;仅 app assembly、迁移脚本与
 * adapter 集成测试可引用,包内业务代码不得 import 本入口(架构测试锁死)。
 */
export type { AccountStorePort } from './ports/account-store.js';
export type { SessionInvalidationPort, SESSION_REALM } from './ports/session-invalidation.js';

// ---- billing FundingSourceResolver 桥（gateway P5 波 C-G4；SQL 面，装配取件） ----
export {
  createPgFundingSourceResolver,
  type PgFundingSourceResolver,
  type ResolvedFunding,
} from './adapters/postgres/funding-resolver.js';

// ---- worker 佣金循环的营销参数读（worker 波；SQL 面，装配取件） ----
// worker 只读 marketing_settings 现值（referralCommissionRate），不经完整
// accounts facade（那需要 identity 会话失效等桥）——存储 port 直取（§5.3）。
export { createPostgresAccountStore } from './adapters/postgres/account-store.js';
