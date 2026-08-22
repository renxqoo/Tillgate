/**
 * billing 错误目录（AGENT.md §11：码的唯一登记处，随迁移单元增量登记）。
 * 禁止自造错误类体系；需要精确捕获处经 entry() 固化子类（errors README §2.1 路径 B）。
 * 不变量破坏不进目录——用根契约 DefectError（码 billing.wallet_invariant / billing.fingerprint_input）。
 * U0：金额域输入拒绝。U1a：钱包域白名单、出账口径、冻结单状态机。
 * U1b：钱包动词的幂等/归属/账户冻结拒绝。
 */
import { defineErrorCatalog } from '@tokenlens/errors';

export const BillingErrors = defineErrorCatalog('billing', {
  invalid_amount: {
    category: 'invalid_input',
    message: 'Invalid monetary amount',
    zh: '金额非法',
  },
  invalid_ref: {
    category: 'invalid_input',
    message: 'Invalid wallet reference (refType / refId / currency / internal account code)',
    zh: '钱包引用非法（业务域 / 幂等键 / 币种 / 内部科目）',
  },
  insufficient_balance: {
    category: 'quota_exhausted',
    message: 'Insufficient available balance (credit basis: balance + credit limit − in-flight)',
    zh: '可用余额不足（信用口径：余额 + 授信 − 在途）',
  },
  insufficient_cash: {
    category: 'quota_exhausted',
    message: 'Insufficient cash balance (cash basis: credit limit excluded)',
    zh: '现金余额不足（现金口径：授信不参与）',
  },
  credit_limit_conflict: {
    category: 'conflict',
    message: 'New credit limit does not cover current exposure',
    zh: '新授信未覆盖当前敞口',
  },
  authorization_not_active: {
    category: 'conflict',
    message: 'Authorization is not active (settled / released / expired)',
    zh: '冻结单不在可操作状态（已结算 / 已释放 / 已过期）',
  },
  settle_exceeds_hold: {
    category: 'invalid_input',
    message: 'Settlement amount exceeds the held authorization amount',
    zh: '结算金额超过冻结额',
  },
  account_frozen: {
    category: 'forbidden',
    message: 'Wallet account is frozen (risk control); all money movement is rejected',
    zh: '账户已被风控冻结，拒绝一切资金变动',
  },
  ref_key_conflict: {
    category: 'conflict',
    message: 'Idempotency key already owned by another account (ref key hijack)',
    zh: '幂等键已被其他账户持有（键劫持）',
  },
  idempotency_conflict: {
    category: 'conflict',
    message: 'Idempotency key reused with a different command',
    zh: '同一幂等键携带不同命令',
  },
  authorization_not_found: {
    category: 'not_found',
    message: 'Authorization not found for the given reference key',
    zh: '冻结单不存在',
  },
});
