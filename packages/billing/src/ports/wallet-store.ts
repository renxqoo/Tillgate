/**
 * 钱包存储 port（application ↔ adapters 的唯一契约；总纲 §5「真实 I/O 走 ports ← adapters」）。
 *
 * 事务模型：事务边界属于发起状态变化的动词（DESIGN §2.1）——
 *   - `transaction(fn)`：动词自开事务（40P01/40001 自动重试，策略由装配注入 adapters）；
 *   - `tx` 参数形态：包内 application 上层用例（如 U2 计费授权）在同一事务内编排钱包动词，
 *     句柄仅在包内流动，root index 不导出其构造途径。
 * 表族 = 聚合：accounts/transactions/legs/authorizations 四表是复式记账的不可分单元
 * （腿链跨表恒等 + Σ=0 由提交期触发器在四表间联查）。
 */
import type { AccountSnapshot } from '../domain/wallet/accounts.js';
import type { AuthorizationSnapshot } from '../domain/wallet/authorization.js';

/** 只读会话句柄（opaque：仅 adapters 构造） */
export interface WalletConn {
  readonly connBrand: 'wallet-conn';
}

/** 写事务句柄（opaque：仅 adapters 构造；可当只读会话用） */
export interface WalletTx extends WalletConn {
  readonly txBrand: 'wallet-tx';
}

/** 交易批头读侧形状（幂等重放定位与回执读回） */
export interface TransactionHeader {
  id: number;
  kind: string;
  commandFingerprint: string | null;
  /** credit_line 审计回执（其余 kind 为 null）——幂等重放的读回依据 */
  creditLimitAfter: string | null;
}

/** 流水条目（腿级读侧形状；金额未规范化，出口由动词统一 normalizeAmount） */
export interface StatementItemRow {
  legId: number;
  transactionKind: string;
  refType: string;
  refId: string;
  amount: string;
  balanceAfter: string;
  memo: string | null;
  createdAt: Date;
}

/** 钱包复式账本聚合存储（无状态；金额一律 string，语义判定与错误翻译在 domain/动词） */
export interface WalletStore {
  /** 只读池会话（幂等快速路径查询；不开事务） */
  read<T>(fn: (conn: WalletConn) => Promise<T>): Promise<T>;
  /** 动词自开事务（重试策略在 adapter 装配注入） */
  transaction<T>(fn: (tx: WalletTx) => Promise<T>): Promise<T>;
  /**
   * 加入上层用例的既有事务：SAVEPOINT 隔离 + 瞬态重试——失败只回滚到保存点，
   * 外层事务不受损（修复旧仓注入路径 23505 毒化外层事务的隐患，见 MIGRATION-U1 §4）。
   */
  joinTransaction<T>(tx: WalletTx, fn: (tx: WalletTx) => Promise<T>): Promise<T>;

  // ---------- 账户 ----------
  /** 解析用户账户（无则建）；返回账户 id */
  ensureUserAccount(conn: WalletConn, userId: number, currency: string): Promise<string>;
  /** 解析内部科目账户（无则建；shard 恒 0——B9：分片保留位未启用，活路径语义唯一） */
  ensureInternalAccount(conn: WalletConn, code: string, currency: string): Promise<string>;
  /** 只读定位用户账户（幂等重放路径禁止建空账户） */
  findUserAccountId(conn: WalletConn, userId: number, currency: string): Promise<string | null>;
  /** 只读定位内部科目账户（shard 0） */
  findInternalAccountId(conn: WalletConn, code: string, currency: string): Promise<string | null>;
  /**
   * 按 id 定序锁定多账户（死锁安全：全局一致加锁顺序；FOR UPDATE）。
   * 冻结账户原样返回——「冻结拒绝一切资金变动」是领域判定，在动词层抛 account_frozen。
   */
  lockAccounts(tx: WalletConn, accountIds: readonly string[]): Promise<AccountSnapshot[]>;
  /** 用户全部币种账户摘要（读侧） */
  userAccountSummaries(conn: WalletConn, userId: number): Promise<AccountSnapshot[]>;

  // ---------- 冻结单 ----------
  findAuthorization(
    conn: WalletConn,
    refType: string,
    refId: string,
  ): Promise<AuthorizationSnapshot | null>;
  /** 行级锁（结算/释放前先锁再做领域校验） */
  lockAuthorization(
    tx: WalletConn,
    refType: string,
    refId: string,
  ): Promise<AuthorizationSnapshot | null>;
  insertAuthorization(
    tx: WalletConn,
    input: {
      accountId: string;
      refType: string;
      refId: string;
      amount: string;
      expiresAt: Date | null;
      memo: string | null;
      authorizeFingerprint: string;
    },
  ): Promise<string>;
  /** CAS active→settled；0 行命中 = 并发对手已了结（调用方走重放/拒绝分岔） */
  casSettleAuthorization(
    tx: WalletConn,
    id: string,
    settledAmount: string,
  ): Promise<{ accountId: string; heldAmount: string } | null>;
  /** CAS active→released（审计在单据：reason + 释放指纹；不落交易） */
  casReleaseAuthorization(
    tx: WalletConn,
    id: string,
    releaseReason: string,
    releaseFingerprint: string,
  ): Promise<{ accountId: string; amount: string } | null>;

  // ---------- 过账 ----------
  /** 幂等重放定位（refType, refId, kind 唯一） */
  findTransaction(
    conn: WalletConn,
    refType: string,
    refId: string,
    kind: string,
  ): Promise<TransactionHeader | null>;
  /** 重放回执：某交易在某账户上的腿（金额 + 余额快照） */
  findLeg(
    conn: WalletConn,
    transactionId: number,
    accountId: string,
  ): Promise<{ amount: string; balanceAfter: string } | null>;
  /** 冻结单归属者（幂等键跨主体顶撞判定） */
  accountOwner(
    conn: WalletConn,
    accountId: string,
  ): Promise<{ userId: number | null; currency: string } | null>;
  insertTransaction(
    tx: WalletConn,
    input: {
      kind: string;
      refType: string;
      refId: string;
      memo: string | null;
      creditLimitAfter: string | null;
      frozenAfter: boolean | null;
      commandFingerprint: string;
    },
  ): Promise<number>;
  /** 落一条腿并推进账户余额（腿链恒等由领域算 before/after，DB check 同律兜底） */
  applyLeg(
    tx: WalletConn,
    input: {
      transactionId: number;
      accountId: string;
      currency: string;
      amount: string;
      balanceBefore: string;
      balanceAfter: string;
    },
  ): Promise<void>;
  /** 账户在途敞口绝对值设置（authorize/settle/release 专用；账户行必须已锁） */
  setInFlight(tx: WalletConn, accountId: string, value: string): Promise<void>;
  /** 账户授信地板绝对值设置（credit_line 专用；账户行必须已锁） */
  setCreditLimit(tx: WalletConn, accountId: string, value: string): Promise<void>;
  /** 数据库时钟（过期判定必须用 DB now——多副本时钟漂移防线） */
  databaseNow(conn: WalletConn): Promise<Date>;

  // ---------- 流水（读侧） ----------
  /** 用户资金流水页（腿级；id 倒序 + before 游标） */
  statementPage(
    conn: WalletConn,
    input: {
      userId: number;
      kinds?: readonly string[];
      limit: number;
      beforeLegId?: number;
    },
  ): Promise<StatementItemRow[]>;

  /** PG 唯一冲突（SQLSTATE 23505）：幂等竞态的兜底信号——并发同键第二个 INSERT 落此处 */
  isUniqueViolation(error: unknown): boolean;
}
