/**
 * 资金来源策略契约（funding-package-plan §3.2 定案形态）：
 * authorize 管线的「PAYG vs 订阅」三次分叉（闸/占/放）收敛为来源解析 + 多态。
 *
 * 错误语义（§3.6 开关式，动态判定）：
 *   结构性非法（订阅过期/越权/成员超限）→ probe 抛错，瀑布中断，整个授权拒绝
 *   开关 OFF + 覆盖不足 → 抛 QuotaExhausted（整单拒绝，= 存量行为）
 *   开关 ON  + 覆盖不足 → 返回余量（≥0），缺口留给后续来源补差
 *   可选型来源不可用 → 返回 0，跳过
 * probe 返回值契约：恒 ≥ 0（负余量防御性 clamp，不得污染 Decimal.min）。
 */
import type { Decimal } from '@ai-gateway/domain';
import type { RepoContext } from '@ai-gateway/repository';

/** 来源类型（开放集合：promo / enterprise 将来增量注册，管线零改动） */
export type SourceType = 'payg' | 'subscription' | 'promo' | 'enterprise' | (string & {});

/** 一笔来源预占（= billing_reservations 一行的领域形状） */
export interface SourceReservation {
  billingRequestId: string;
  sourceType: SourceType;
  sourceRefId: number | null;
  amount: string;
}

/**
 * 来源上下文：凭证 + 预解析结果（§3.10——凭证→订阅绑定与开关由 authorize 统一查一次，
 * 策略不重复查库；策略的 probe 只查自己域内的数据）。
 */
export interface FundingSourceContext {
  userId: number;
  /** 计费币种（装配注入——来源按此口径挑账户/算额度） */
  currency: string;
  credential: { apiKeyId: number | null; appId: number | null };
  resolved: {
    subscriptionId: number | null;
    /** api_keys.allow_payg_fallback（App JWT 恒 false） */
    allowPaygFallback: boolean;
  };
  model?: string;
}

export interface ProbeInput {
  userId: number;
  /** 幂等重放时暴露量口径须排除自身请求（不得把本请求算两遍） */
  requestId: string;
  /** 瀑布当前缺口（还差多少）——策略据此判定「覆盖不足」并选择抛错或返回部分额 */
  amount: string;
  now: Date;
  context: FundingSourceContext;
}

export interface ReserveInput {
  userId: number;
  requestId: string;
  amount: string;
  now: Date;
  context: FundingSourceContext;
}

/** 结算入参：分配规则（domain 的 allocateSettlement）产物落到某一来源 */
export interface SourceSettleInput {
  userId: number;
  requestId: string;
  reservation: SourceReservation;
  /** 本源消耗（≤ 预留额；余量随结算原语隐式归还） */
  consume: string;
  /** 超额（actual > Σ预留）：由最后一个资金源补充入账；余额不足也必须形成全额应收 */
  over: string;
  now: Date;
}

export interface FundingSource {
  readonly type: SourceType;
  /** 消费优先级（小先耗：订阅 10 先于 PAYG 兜底 100） */
  readonly priority: number;

  /** 解析链准入过滤（普通 Key 恒不适用订阅——即使该用户有活跃订阅） */
  applies(context: FundingSourceContext): boolean;

  /** 验证 + 可用额（单次调用，不动账）：见本文件头部的错误语义 */
  probe(c: RepoContext, input: ProbeInput): Promise<Decimal>;

  /** 预占 exactAmount（调用方保证 ≤ probe 返回值；advisory 锁内同 user 无竞态，跨 user 由守卫 WHERE 兜底） */
  reserve(c: RepoContext, input: ReserveInput): Promise<SourceReservation>;

  /**
   * 归还预扣：缺省整笔；结算差额按 amount 部分释放（结算路径 consume < 预留额时）。
   */
  release(c: RepoContext, reservation: SourceReservation, amount?: string): Promise<void>;

  /**
   * 结算：按分配结果核销本源份额（consume ≤ 预留额，余量由原语隐式归还）；
   * over > 0 = 超额，PAYG 以 §4 补充授权（authorize#over + settle#over）吸收。
   */
  settle(c: RepoContext, input: SourceSettleInput): Promise<void>;
}
