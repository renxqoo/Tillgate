/**
 * billing 错误目录（码的唯一登记处）。
 * 禁止自造错误类体系；需要精确捕获处经 entry() 固化子类。
 * 不变量破坏不进目录——用根契约 DefectError（码 billing.wallet_invariant / billing.fingerprint_input）。
 */
import { defineErrorCatalog } from '@tillgate/errors';

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
  debit_floor_conflict: {
    category: 'conflict',
    message:
      'Lowering the debit floor would breach current exposure (balance + credit + new floor − in-flight < 0); recover or top up first',
    zh: '降低透支地板会击穿当前敞口（余额 + 授信 + 新地板 − 在途 < 0），请先恢复或充值',
  },
  funds_held_in_flight: {
    category: 'quota_exhausted',
    message:
      'Balance is sufficient but held by in-flight reservations; retry after settlements complete',
    zh: '余额充足但被在途预扣占用，待结算完成后重试',
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
  invalid_period_days: {
    category: 'invalid_input',
    message: 'Invalid periodDays for plan kind (subscription 1-3650 / pack must be 0)',
    zh: '套餐周期与类型不一致（包月 1-3650 / 加油包恒 0）',
  },
  plan_in_use: {
    category: 'conflict',
    message: 'Plan has associated subscriptions (including history); disable it instead',
    zh: '套餐已被订阅引用（含历史），不能删除；请下架',
  },
  redeem_batch_not_found: {
    category: 'not_found',
    message: 'Redeem batch not found',
    zh: '兑换批次不存在',
  },
  redeem_code_not_found: {
    category: 'not_found',
    message: 'Redeem code not found, already used or revoked',
    zh: '兑换码不存在、已使用或已作废',
  },
  invalid_review_command: {
    category: 'invalid_input',
    message: 'Invalid review command (reason 1-1000 characters required)',
    zh: '复核命令非法（理由必填 1-1000 字符）',
  },
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
  // ---- 订阅生命周期 ----
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
  // ---- 支付与兑换 ----
  topup_amount_invalid: {
    category: 'invalid_input',
    message: 'Top-up amount invalid (decimals / below minimum / above maximum)',
    zh: '充值金额非法（小数位 / 低于下限 / 超过上限）',
  },
  payment_unavailable: {
    category: 'unavailable',
    message: 'Payment channel not enabled or not selectable',
    zh: '支付渠道未启用或须显式选择',
  },
  payment_channel_unavailable: {
    category: 'unavailable',
    message: 'Payment channel temporarily unavailable (order closed for trace)',
    zh: '支付渠道暂时不可用（订单已关单留痕）',
  },
  topup_rate_limited: {
    category: 'rate_limited',
    message: 'Too many top-up order requests, retry later',
    zh: '下单过于频繁，请稍后再试',
  },
  order_not_found: {
    category: 'not_found',
    message: 'Payment order not found for this user',
    zh: '支付订单不存在',
  },
  order_state_conflict: {
    category: 'conflict',
    message: 'Payment order state transition conflict',
    zh: '支付订单状态迁移冲突',
  },
  rate_counter_unavailable: {
    category: 'unavailable',
    message: 'Rate counter unavailable — request rejected (fail-closed)',
    zh: '频率计数器不可用——请求拒绝（fail-closed）',
  },
  invalid_code: {
    category: 'not_found',
    message: 'Invalid redeem code',
    zh: '兑换码无效',
  },
  code_revoked: {
    category: 'conflict',
    message: 'Redeem code has been revoked',
    zh: '兑换码已被吊销',
  },
  code_already_used: {
    category: 'conflict',
    message: 'Redeem code already used',
    zh: '兑换码已被使用',
  },
  code_expired: {
    category: 'invalid_input',
    message: 'Redeem code has expired',
    zh: '兑换码已过期',
  },
  redeem_rate_limited: {
    category: 'rate_limited',
    message: 'Redeem attempts too frequent, retry later',
    zh: '兑换尝试过于频繁，请稍后再试',
  },
  settlement_backlog: {
    category: 'unavailable',
    message: 'Settlement backlog too deep or too old — new requests rejected (self-protection)',
    zh: '结算积压过深/过老，暂停受理新请求（自我保护）',
  },
});
