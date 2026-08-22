/**
 * @tokenlens/accounts 公共出口(§5.3):facade、错误目录、policy/命令形状与
 * 端口类型(装配桥接需要)。adapter 不从根入口导出;Db/DbTx 不出现在任何签名。
 */
export { createAccounts, type AccountsEnv } from './accounts.js';
export type { AccountUseCases } from './application/create-use-cases.js';
export type { AccountsPolicy } from './application/context.js';

// ---- 错误目录(face 装配消费) ----
export { AccountsErrors } from './domain/errors.js';

// ---- 领域词表与构造器(跨能力消费的单一真相:幂等键/aff 码/状态) ----
export {
  signupGiftRefId,
  referralSignupRefId,
  commissionRefId,
  encodeAffCode,
  decodeAffCode,
} from './domain/referral.js';
export {
  USER_STATUS,
  CREDENTIAL_STATUS,
  MEMBER_STATUS,
  INVITATION_STATUS,
  REFERRAL_STATUS,
} from './domain/status.js';

// ---- 端口(装配桥接:wallet-credit → billing;audit → observability 存储) ----
export type { AccountStorePort } from './ports/account-store.js';
export type {
  WalletCreditPort,
  CreditCommand,
  CreditResult,
  CreditRefType,
} from './ports/wallet-credit.js';
export type { AuditPort, AuditAction } from './ports/audit.js';
