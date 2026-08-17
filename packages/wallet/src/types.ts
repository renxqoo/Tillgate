/** 钱包对外契约：动词入参/出参与 Wallet 接口（金额恒为字符串，Decimal 全精度）
 *
 * currency 维度：所有动词可选传（ISO 4217 三字母，缺省 CNY）——单币种业务零感知。
 * 一币一账：账户按 (userId, currency) 隔离，跨币不净额（换汇是业务的两腿操作）。
 */

/** 缺省币种——单币种业务的隐式维度 */
export const DEFAULT_CURRENCY = 'CNY';

export interface CreditInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  memo?: string;
}

export interface AuthorizeInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  /** 冻结时限；到点由 releaseExpired 释放（worker 周期调用） */
  expiresAt?: Date;
  currency?: string;
  memo?: string;
}

export interface SettleInput {
  /** 按业务键结算（与 authorize 同 refType/refId） */
  refType: string;
  refId: string;
  /** 实扣金额（可少于冻结额，余量自动归还）；重放时忽略 */
  amount: string;
  memo?: string;
}

export interface ReleaseInput {
  refType: string;
  refId: string;
  reason?: string;
}

export interface RefundInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  memo?: string;
}

/** 授信调整：amount 为新授信额（≥0，0 = 收回授信）；幂等键同其他动词 */
export interface CreditLineInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  memo?: string;
}

export interface CreditResult {
  transactionId: number;
  amount: string;
  balanceAfter: string;
  replayed: boolean;
}

export interface AuthorizeResult {
  authorizationId: string;
  amount: string;
  status: 'active' | 'settled' | 'released' | 'expired';
  expiresAt: string | null;
  replayed: boolean;
}

export interface SettleResult {
  authorizationId: string;
  settledAmount: string;
  balanceAfter: string;
  /** 冻结额与实扣之差（即随结算归还的余量） */
  releasedRemainder: string;
  replayed: boolean;
}

export interface ReleaseResult {
  authorizationId: string;
  amount: string;
  reason: string;
  replayed: boolean;
}

export interface CreditLineResult {
  transactionId: number;
  /** 本笔生效后的授信额 */
  creditLimit: string;
  replayed: boolean;
}

/** 账户摘要（accounts 查询用） */
export interface AccountSummary {
  currency: string;
  balance: string;
  inFlight: string;
  creditLimit: string;
}

export interface Wallet {
  credit(input: CreditInput): Promise<CreditResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  release(input: ReleaseInput): Promise<ReleaseResult>;
  refund(input: RefundInput): Promise<CreditResult>;
  /** 调整授信地板（新额度；0 = 收回）——幂等，落零额审计流水 */
  setCreditLimit(input: CreditLineInput): Promise<CreditLineResult>;
  balance(userId: number, currency?: string): Promise<string>;
  /** 用户全部币种账户摘要 */
  accounts(userId: number): Promise<AccountSummary[]>;
  /** 超时释放扫描（worker 周期调用）；返回本次释放条数 */
  releaseExpired(now?: Date, limit?: number): Promise<{ released: number }>;
}
