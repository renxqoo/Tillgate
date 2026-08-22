/**
 * billing 错误目录（AGENT.md §11：码的唯一登记处，随迁移单元增量登记）。
 * 禁止自造错误类体系；需要精确捕获处经 entry() 固化子类（errors README §2.1 路径 B）。
 * 不变量破坏不进目录——用根契约 DefectError（码 billing.wallet_invariant / billing.fingerprint_input）。
 * U0：金额域输入拒绝。U1a：钱包域白名单、出账口径、冻结单状态机。
 * U1b：钱包动词的幂等/归属/账户冻结拒绝。
 * U2a：计价域配置事故/毒收据；计费域状态机/限额/订阅闸。U3：结算。U4：订阅生命周期。
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
  // ---- U2a：计价域（rating）配置事故与毒收据 ----
  invalid_quote: {
    category: 'invalid_input',
    message:
      'Billing quote is structurally invalid (empty / zero-priced without free flag / mismatched)',
    zh: '报价结构非法（空候选 / 零价未声明免费 / 口径不一致）',
  },
  invalid_coefficient: {
    category: 'invalid_input',
    message: 'Rate-card coefficient is not a positive finite decimal',
    zh: '费率卡系数非法（须为正有限小数）',
  },
  invalid_reservation_estimate: {
    category: 'invalid_input',
    message: 'Reservation estimate is not a finite non-negative amount',
    zh: '预扣预估非法（须为有限非负金额）',
  },
  invalid_reservation_limit: {
    category: 'invalid_input',
    message: 'Per-request reservation limit is not a positive finite amount',
    zh: '单请求预扣上限非法（须为正有限金额）',
  },
  reservation_limit_exceeded: {
    category: 'quota_exhausted',
    message: 'Estimated cost exceeds the per-request reservation limit',
    zh: '预估费用超过单请求预扣上限',
  },
  invalid_reservation_balance: {
    category: 'invalid_input',
    message: 'Fixed funding-reservation amount is not a positive amount',
    zh: '固定预扣门槛金额非法',
  },
  invalid_reservation_units: {
    category: 'invalid_input',
    message: 'Reservation floor units must be a positive integer',
    zh: '预扣保底单位数须为正整数',
  },
  unknown_reservation_strategy: {
    category: 'invalid_input',
    message: 'Unknown reservation strategy declared in billing config',
    zh: '计费配置声明了未知预扣策略',
  },
  poison_receipt: {
    category: 'invalid_input',
    message:
      'Poison usage receipt (structure / numbers / price snapshot invalid) — dead-letter for manual review',
    zh: '毒收据（结构/数值/价格快照非法）——死信人工复核',
  },
  receipt_user_mismatch: {
    category: 'invalid_input',
    message: 'Receipt user does not match the authorized billing request',
    zh: '收据用户与授权账单不一致',
  },
  // ---- U2a：计费域（billing）状态机/限额/订阅闸 ----
  state_conflict: {
    category: 'conflict',
    message: 'Billing request is not in the required state for this operation',
    zh: '计费请求不在本操作所需状态',
  },
  daily_spend_limit: {
    category: 'quota_exhausted',
    message: 'Daily spend limit exceeded (settled + in-flight + this request)',
    zh: '超过每日花费限额（已结算 + 在途 + 本次）',
  },
  member_daily_limit: {
    category: 'quota_exhausted',
    message: 'Organization member daily spend limit exceeded',
    zh: '超过组织成员每日花费限额',
  },
  member_monthly_quota: {
    category: 'quota_exhausted',
    message: 'Organization member monthly quota exceeded',
    zh: '超过组织成员月度配额',
  },
  subscription_forbidden: {
    category: 'forbidden',
    message: 'Credential-bound subscription not allowed for this user (not owner nor org member)',
    zh: '无权使用该订阅（既非所有者也非组织成员）',
  },
  subscription_required: {
    category: 'quota_exhausted',
    message: 'No active subscription bound to this credential',
    zh: '凭证未绑定有效订阅',
  },
  subscription_quota_exhausted: {
    category: 'quota_exhausted',
    message: 'Subscription quota exhausted for this request',
    zh: '订阅剩余额度不足以覆盖本请求',
  },
  // ---- U4：订阅生命周期 ----
  plan_not_found: {
    category: 'not_found',
    message: 'Plan not found',
    zh: '套餐不存在',
  },
  plan_disabled: {
    category: 'conflict',
    message: 'Plan is not on sale',
    zh: '套餐已停售',
  },
  plan_not_purchasable: {
    category: 'invalid_input',
    message:
      'Plan is not purchasable (zero-priced self-serve plans are forbidden — free-quota minting guard)',
    zh: '套餐不可购买（自助上架套餐必须正价——免费额度印刷机防线）',
  },
  not_a_pack: {
    category: 'invalid_input',
    message: 'Operation requires a pack-kind plan (or subscription-kind, mismatched)',
    zh: '套餐类型不匹配（订阅/加油包）',
  },
  user_not_found: {
    category: 'not_found',
    message: 'User not found',
    zh: '用户不存在',
  },
  subscription_state: {
    category: 'conflict',
    message: 'Subscription state conflict (already subscribed / no active subscription / inactive)',
    zh: '订阅状态冲突（已订阅 / 无有效订阅 / 已失效）',
  },
  subscription_rule: {
    category: 'invalid_input',
    message: 'Subscription rule violation (quantity / seats / enterprise / downgrade)',
    zh: '订阅规则不允许（数量 / 席位 / 企业 / 降档）',
  },
  settlement_backlog: {
    category: 'unavailable',
    message: 'Settlement backlog too deep or too old — new requests rejected (self-protection)',
    zh: '结算积压过深/过老，暂停受理新请求（自我保护）',
  },
});
