/** 钱包对外契约：动词入参/出参与 Wallet 接口（金额恒为字符串，Decimal 全精度）。
 *
 * 复式模型：每笔资金交易 = 批头（幂等键）+ ≥2 条腿（Σ=0，有借必有贷）。
 * credit/settle/refund 自动生成对手腿（counterparty 可选，默认内部科目）。
 */
import type { DbLike } from './internal';

/** 事务注入：缺省动词自开事务；传入 tx 则加入调用方事务（SAVEPOINT 语义，
 *  提交/回滚权归调用方）——「业务行 + 资金变动」同生共死的组合手段。
 *  tx 不参与命令指纹（连接句柄非业务数据）。 */
export interface TxInput {
  tx?: DbLike;
}

/** 缺省币种——单币种业务的隐式维度 */
export const DEFAULT_CURRENCY = 'CNY';

/** 缺省对手科目：credit 的资金来源（外部世界，余额为全体账户镜像） */
export const OUTSIDE_ACCOUNT = 'outside';
/** 缺省对手科目：settle 的收入确认 / refund 的收入冲回 */
export const REVENUE_ACCOUNT = 'platform_revenue';

/** 账户寻址：userId（用户账户）或 code（内部科目）二选一 */
export interface AccountRef {
  userId?: number;
  code?: string;
  currency?: string;
}

export interface CreditInput extends TxInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  /** 入账资金来源科目（缺省 outside） */
  counterparty?: string;
  memo?: string;
}

export interface AuthorizeInput extends TxInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  /** 冻结时限；到点由 releaseExpired 释放（worker 周期调用） */
  expiresAt?: Date;
  currency?: string;
  /** 允许动用授信（缺省 true）。false = 现金口径守卫 balance − in_flight ≥ amount
   *  （禁透支场景：订阅购买等），拒绝抛 InsufficientCashError。 */
  allowCredit?: boolean;
  memo?: string;
}

export interface SettleInput extends TxInput {
  /** 按业务键结算（与 authorize 同 refType/refId） */
  refType: string;
  refId: string;
  /** 实扣金额（可少于冻结额，余量自动归还）；同键异参会拒绝 */
  amount: string;
  /** 结算收入确认科目（缺省 platform_revenue） */
  counterparty?: string;
  memo?: string;
}

export interface ReleaseInput extends TxInput {
  refType: string;
  refId: string;
  reason?: string;
}

export interface RefundInput extends TxInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  /** 收入冲回科目（缺省 platform_revenue） */
  counterparty?: string;
  memo?: string;
}

export interface TransferInput extends TxInput {
  from: AccountRef;
  to: AccountRef;
  amount: string;
  refType: string;
  refId: string;
  /** from 为用户账户时的现金口径开关（同 AuthorizeInput.allowCredit） */
  allowCredit?: boolean;
  memo?: string;
}

/** 授信调整：amount 为新授信额（≥0，0 = 收回授信）；幂等键同其他动词 */
export interface CreditLineInput extends TxInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  currency?: string;
  memo?: string;
}

/** 账户冻结/解冻（风控）：零额审计交易，幂等 */
export interface FreezeInput extends TxInput {
  target: AccountRef;
  frozen: boolean;
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

export interface TransferResult {
  transactionId: number;
  amount: string;
  fromBalanceAfter: string;
  toBalanceAfter: string;
  replayed: boolean;
}

export interface CreditLineResult {
  transactionId: number;
  /** 本笔生效后的授信额 */
  creditLimit: string;
  replayed: boolean;
}

export interface FreezeResult {
  transactionId: number;
  frozen: boolean;
  replayed: boolean;
}

/** 账户摘要（accounts 查询用） */
export interface AccountSummary {
  currency: string;
  balance: string;
  inFlight: string;
  creditLimit: string;
}

/** 流水查询（账单页/对账导出）：游标分页，newest-first，只读 */
export interface StatementInput {
  userId: number;
  currency?: string;
  /** 按交易种类过滤（credit/settle/refund/transfer/credit_line/freeze） */
  kinds?: readonly ('credit' | 'settle' | 'refund' | 'transfer' | 'credit_line' | 'freeze')[];
  /** 游标：返回 transactionId 严格小于它的记录（首页不传） */
  before?: number;
  /** 页大小 1–100，缺省 20 */
  limit?: number;
}

export interface StatementCounterparty {
  kind: 'user' | 'internal';
  userId: number | null;
  code: string | null;
}

export interface StatementItem {
  transactionId: number;
  kind: string;
  refType: string;
  refId: string;
  currency: string;
  /** 本方腿有符号金额（正=入，负=出） */
  amount: string;
  /** 本腿落账后余额——逐条连起来就是完整余额历史 */
  balanceAfter: string;
  memo: string | null;
  createdAt: string;
  /** 同交易对手腿的账户（钱从哪来/到哪去） */
  counterparties: StatementCounterparty[];
}

export interface StatementResult {
  items: StatementItem[];
  /** 下一页游标（null = 没有更多）；传入下次请求的 before */
  nextCursor: number | null;
}

/** 三张白名单（**必填**，fail-closed：未声明的科目/业务域/币种一律拒绝）。
 *  各堵一类静默错误：
 *    accounts   —— 科目拼错会静默建科目、钱进错抽屉（Σ腿=0 抓不到）
 *    refTypes   —— 业务域拼错会让幂等域分裂，同一单号双入账
 *    currencies —— 币种拼错会静默建新币种账户，余额"隐身"
 *  内置科目 outside / platform_revenue 恒可用，无需声明。 */
export interface CreateWalletOptions {
  /** 允许的内部科目 code 白名单（内置科目免声明） */
  accounts: readonly string[];
  /** 允许的 refType 业务域白名单 */
  refTypes: readonly string[];
  /** 允许的币种白名单（如 ['CNY', 'USD']） */
  currencies: readonly string[];
  /** 缺省币种；必须包含在 currencies，默认 CNY。 */
  defaultCurrency?: string;
  /** 内部科目物理分片数，降低全局收入/外部科目热点；默认 16，范围 1–256。 */
  internalAccountShards?: number;
  /** 可选观测钩子；异常会被吞掉，绝不影响资金事务。 */
  telemetry?: WalletTelemetry;
}

export type WalletOperation = keyof Wallet;

export interface WalletOperationEvent {
  operation: WalletOperation;
  outcome: 'success' | 'error';
  durationMs: number;
  replayed?: boolean;
  errorCode?: string;
}

export interface WalletTransactionRetryEvent {
  operation: string;
  /** 从 1 开始的重试序号。 */
  attempt: number;
  code: '40P01' | '40001';
}

export interface WalletTelemetry {
  onOperation?(event: WalletOperationEvent): void;
  onTransactionRetry?(event: WalletTransactionRetryEvent): void;
}

export interface Wallet {
  credit(input: CreditInput): Promise<CreditResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  release(input: ReleaseInput): Promise<ReleaseResult>;
  refund(input: RefundInput): Promise<CreditResult>;
  /** 原子转账（分账/P2P/手续费）：双腿守恒，from/to 可为用户或内部科目 */
  transfer(input: TransferInput): Promise<TransferResult>;
  /** 调整授信地板（新额度；0 = 收回）——幂等，落零额审计交易 */
  setCreditLimit(input: CreditLineInput): Promise<CreditLineResult>;
  /** 冻结/解冻账户（风控）——幂等，落零额审计交易；冻结账户拒绝一切资金变动 */
  freeze(input: FreezeInput): Promise<FreezeResult>;
  balance(userId: number, currency?: string): Promise<string>;
  /** 用户全部币种账户摘要 */
  accounts(userId: number): Promise<AccountSummary[]>;
  /** 流水查询（账单页/对账导出）：游标分页 newest-first，只读零副作用 */
  statement(input: StatementInput): Promise<StatementResult>;
}
