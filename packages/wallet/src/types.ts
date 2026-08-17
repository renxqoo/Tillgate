/** 钱包对外契约：动词入参/出参与 Wallet 接口（金额恒为字符串，Decimal 全精度） */

export interface CreditInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  memo?: string;
}

export interface AuthorizeInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  /** 冻结时限；到点由 releaseExpired 释放（worker 周期调用） */
  expiresAt?: Date;
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

export interface Wallet {
  credit(input: CreditInput): Promise<CreditResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  release(input: ReleaseInput): Promise<ReleaseResult>;
  refund(input: RefundInput): Promise<CreditResult>;
  balance(userId: number): Promise<string>;
  /** 超时释放扫描（worker 周期调用）；返回本次释放条数 */
  releaseExpired(now?: Date, limit?: number): Promise<{ released: number }>;
}
