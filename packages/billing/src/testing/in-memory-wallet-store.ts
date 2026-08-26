/**
 * 内存版 WalletStore stand-in（§5.6 类别 2「行为等价 stand-in」）：
 * 供 application 动词在无 PG 环境下的契约测试（默认门禁）；真实 PostgreSQL 语义
 * （行锁并发、触发器不变量、SQLSTATE）由 adapters/postgres + *.real.test.ts 验证。
 *
 * 与 PG 的语义对齐点：唯一键（交易 (refType,refId,kind) / 冻结单 (refType,refId) /
 * 账户身份）冲突抛 code='23505' 形状错误；CAS 返回 null 表竞态输家；
 * 定序锁在单线程下退化为直接快照返回。
 * 竞态窗口模拟：`suppressNextFind*` 跳过一次幂等快速路径——确定性触发
 * 「快速路径未命中 → 写路径撞唯一键 → 兜底重放」分支（真实并发在 PG 语义中验证）。
 */

/** 与 PG SQLSTATE 23505 同形的冲突错误（isUniqueViolation 探测 cause 链） */
import { Decimal } from '../domain/money.js';
import type { WalletStore } from '../ports/wallet-store.js';

/** 与 PG SQLSTATE 23505 同形的冲突错误（isUniqueViolation 探测 cause 链） */
export class UniqueViolationError extends Error {
  readonly code = '23505';
}

interface AccountRow {
  id: string;
  kind: string;
  userId: number | null;
  code: string | null;
  shard: number;
  currency: string;
  balance: string;
  inFlight: string;
  creditLimit: string;
  status: string;
}

interface AuthorizationRow {
  id: string;
  accountId: string;
  refType: string;
  refId: string;
  amount: string;
  status: string;
  settledAmount: string | null;
  releaseReason: string | null;
  memo: string | null;
  authorizeFingerprint: string | null;
  releaseFingerprint: string | null;
  expiresAt: Date | null;
}

interface TransactionRow {
  id: number;
  kind: string;
  refType: string;
  refId: string;
  memo: string | null;
  creditLimitAfter: string | null;
  frozenAfter: boolean | null;
  commandFingerprint: string | null;
}

interface LegRow {
  id: number;
  transactionId: number;
  accountId: string;
  currency: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
}

export interface InMemoryWalletStore {
  readonly store: WalletStore;
  /** 跳过一次交易快速路径查询（模拟读后写竞态：写路径将撞唯一键走兜底重放） */
  suppressNextFindTransaction(): void;
  /** 跳过一次冻结单快速路径查询 */
  suppressNextFindAuthorization(): void;
  /** 模拟风控冻结（活路径无 freeze 动词，状态由管理面置位——B9/MIGRATION-U1） */
  freezeUserAccount(userId: number, currency: string): void;
  /** 对账测试专用：绕过动词直改余额制造漂移（运维事故模拟） */
  defaceBalanceForTest(userId: number, currency: string, balance: string): void;
  /**
   * 事务回滚模拟（§5.4 边界测试）：四集合深快照。与 BillingStore 快照配对使用，
   * 由测试的 rollbackable 事务壳在异常时一并还原——模拟 PG 的整事务回滚
   * （内存 stand-in 本身无回滚语义，PG 语义在 *.real.test.ts 验证）。
   */
  snapshotForTest(): WalletStoreSnapshot;
  restoreForTest(snapshot: WalletStoreSnapshot): void;
}

export interface WalletStoreSnapshot {
  accounts: Array<[string, AccountRow]>;
  authorizations: Array<[string, AuthorizationRow]>;
  transactions: TransactionRow[];
  legs: LegRow[];
}

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${(idCounter += 1)}`;

const asSnapshot = (row: AccountRow) => ({
  id: row.id,
  kind: row.kind,
  code: row.code,
  currency: row.currency,
  balance: row.balance,
  inFlight: row.inFlight,
  creditLimit: row.creditLimit,
  status: row.status,
});

const asAuthSnapshot = (row: AuthorizationRow) => ({
  id: row.id,
  accountId: row.accountId,
  refType: row.refType,
  refId: row.refId,
  amount: row.amount,
  status: row.status,
  settledAmount: row.settledAmount,
  authorizeFingerprint: row.authorizeFingerprint,
  expiresAt: row.expiresAt,
});

export function createInMemoryWalletStore(): InMemoryWalletStore {
  const accounts = new Map<string, AccountRow>();
  const authorizations = new Map<string, AuthorizationRow>(); // key: refType\0refId
  const transactions: TransactionRow[] = [];
  const legs: LegRow[] = [];

  let suppressTransaction = false;
  let suppressAuthorization = false;

  const findTx = (refType: string, refId: string, kind: string): TransactionRow | undefined =>
    transactions.find((t) => t.refType === refType && t.refId === refId && t.kind === kind);

  const conn = { connBrand: 'wallet-conn' } as const;
  const txHandle = { ...conn, txBrand: 'wallet-tx' } as const;

  const store: WalletStore = {
    read: (fn) => fn(conn),
    transaction: (fn) => fn(txHandle),
    joinTransaction: (_tx, fn) => fn(txHandle),

    ensureUserAccount(_conn, userId, currency) {
      for (const row of accounts.values()) {
        if (row.kind === 'user' && row.userId === userId && row.currency === currency) {
          return Promise.resolve(row.id);
        }
      }
      const row: AccountRow = {
        id: nextId('acc'),
        kind: 'user',
        userId,
        code: null,
        shard: 0,
        currency,
        balance: '0',
        inFlight: '0',
        creditLimit: '0',
        status: 'active',
      };
      accounts.set(row.id, row);
      return Promise.resolve(row.id);
    },

    ensureInternalAccount(_conn, code, currency) {
      for (const row of accounts.values()) {
        if (
          row.kind === 'internal' &&
          row.code === code &&
          row.currency === currency &&
          row.shard === 0
        ) {
          return Promise.resolve(row.id);
        }
      }
      const row: AccountRow = {
        id: nextId('acc'),
        kind: 'internal',
        userId: null,
        code,
        shard: 0,
        currency,
        balance: '0',
        inFlight: '0',
        creditLimit: '0',
        status: 'active',
      };
      accounts.set(row.id, row);
      return Promise.resolve(row.id);
    },

    findUserAccountId(_conn, userId, currency) {
      for (const row of accounts.values()) {
        if (row.kind === 'user' && row.userId === userId && row.currency === currency) {
          return Promise.resolve(row.id);
        }
      }
      return Promise.resolve(null);
    },

    findInternalAccountId(_conn, code, currency) {
      for (const row of accounts.values()) {
        if (
          row.kind === 'internal' &&
          row.code === code &&
          row.currency === currency &&
          row.shard === 0
        ) {
          return Promise.resolve(row.id);
        }
      }
      return Promise.resolve(null);
    },

    lockAccounts(_conn, accountIds) {
      const ordered = [...new Set(accountIds)].toSorted();
      const rows: ReturnType<typeof asSnapshot>[] = [];
      for (const id of ordered) {
        const row = accounts.get(id);
        if (!row) throw new Error('wallet.lock_accounts_missing');
        rows.push(asSnapshot(row));
      }
      return Promise.resolve(rows);
    },

    userAccountSummaries(_conn, userId) {
      return Promise.resolve(
        [...accounts.values()]
          .filter((row) => row.kind === 'user' && row.userId === userId)
          .map(asSnapshot),
      );
    },

    findAuthorization(_conn, refType, refId) {
      if (suppressAuthorization) {
        suppressAuthorization = false;
        return Promise.resolve(null);
      }
      const row = authorizations.get(`${refType}\0${refId}`);
      return Promise.resolve(row ? asAuthSnapshot(row) : null);
    },

    lockAuthorization(_conn, refType, refId) {
      const row = authorizations.get(`${refType}\0${refId}`);
      return Promise.resolve(row ? asAuthSnapshot(row) : null);
    },

    insertAuthorization(_conn, input) {
      const key = `${input.refType}\0${input.refId}`;
      if (authorizations.has(key)) throw new UniqueViolationError(key);
      const row: AuthorizationRow = {
        id: nextId('auth'),
        accountId: input.accountId,
        refType: input.refType,
        refId: input.refId,
        amount: input.amount,
        status: 'active',
        settledAmount: null,
        releaseReason: null,
        memo: input.memo,
        authorizeFingerprint: input.authorizeFingerprint,
        releaseFingerprint: null,
        expiresAt: input.expiresAt,
      };
      authorizations.set(key, row);
      return Promise.resolve(row.id);
    },

    casSettleAuthorization(_conn, id, settledAmount) {
      for (const row of authorizations.values()) {
        if (row.id === id && row.status === 'active') {
          row.status = 'settled';
          row.settledAmount = settledAmount;
          return Promise.resolve({ accountId: row.accountId, heldAmount: row.amount });
        }
      }
      return Promise.resolve(null);
    },

    // eslint-disable-next-line max-params -- WalletStore 端口契约签名镜像 postgres 实现同口径
    casReleaseAuthorization(_conn, id, releaseReason, releaseFingerprint) {
      for (const row of authorizations.values()) {
        if (row.id === id && row.status === 'active') {
          row.status = 'released';
          row.releaseReason = releaseReason;
          row.releaseFingerprint = releaseFingerprint;
          return Promise.resolve({ accountId: row.accountId, amount: row.amount });
        }
      }
      return Promise.resolve(null);
    },

    // eslint-disable-next-line max-params -- WalletStore 端口契约签名镜像 postgres 实现同口径
    findTransaction(_conn, refType, refId, kind) {
      if (suppressTransaction) {
        suppressTransaction = false;
        return Promise.resolve(null);
      }
      const row = findTx(refType, refId, kind);
      return Promise.resolve(
        row
          ? {
              id: row.id,
              kind: row.kind,
              commandFingerprint: row.commandFingerprint,
              creditLimitAfter: row.creditLimitAfter,
            }
          : null,
      );
    },

    findLeg(_conn, transactionId, accountId) {
      const row = legs.find((l) => l.transactionId === transactionId && l.accountId === accountId);
      return Promise.resolve(row ? { amount: row.amount, balanceAfter: row.balanceAfter } : null);
    },

    accountOwner(_conn, accountId) {
      const row = accounts.get(accountId);
      return Promise.resolve(row ? { userId: row.userId, currency: row.currency } : null);
    },

    insertTransaction(_conn, input) {
      if (findTx(input.refType, input.refId, input.kind)) {
        throw new UniqueViolationError(`${input.refType}\0${input.refId}\0${input.kind}`);
      }
      const row: TransactionRow = {
        id: transactions.length + 1,
        kind: input.kind,
        refType: input.refType,
        refId: input.refId,
        memo: input.memo,
        creditLimitAfter: input.creditLimitAfter,
        frozenAfter: input.frozenAfter,
        commandFingerprint: input.commandFingerprint,
      };
      transactions.push(row);
      return Promise.resolve(row.id);
    },

    applyLeg(_conn, input) {
      const row = accounts.get(input.accountId);
      if (!row) throw new Error('wallet.apply_leg_account_missing');
      legs.push({
        id: legs.length + 1,
        transactionId: input.transactionId,
        accountId: input.accountId,
        currency: input.currency,
        amount: input.amount,
        balanceBefore: input.balanceBefore,
        balanceAfter: input.balanceAfter,
      });
      row.balance = input.balanceAfter;
      return Promise.resolve();
    },
    async conditionalReserve(_conn, input) {
      const account = accounts.get(input.accountId);
      if (account == null || account.status !== 'active') return null;
      if (!input.collectOverage) {
        const credit =
          input.guardKind === 'cash' ? new Decimal(0) : new Decimal(account.creditLimit);
        const available = new Decimal(account.balance)
          .plus(credit)
          .minus(new Decimal(account.inFlight));
        if (available.lt(new Decimal(input.amount))) return null;
      }
      account.inFlight = new Decimal(account.inFlight).plus(new Decimal(input.amount)).toString();
      return { balance: account.balance, creditLimit: account.creditLimit, inFlight: account.inFlight };
    },

    setInFlight(_conn, accountId, value) {
      const row = accounts.get(accountId);
      if (!row) throw new Error('wallet.set_in_flight_missing');
      row.inFlight = value;
      return Promise.resolve();
    },

    setCreditLimit(_conn, accountId, value) {
      const row = accounts.get(accountId);
      if (!row) throw new Error('wallet.set_credit_limit_missing');
      row.creditLimit = value;
      return Promise.resolve();
    },

    databaseNow() {
      return Promise.resolve(new Date());
    },

    statementPage(_conn, input) {
      const accountIds = new Set(
        [...accounts.values()]
          .filter((row) => row.kind === 'user' && row.userId === input.userId)
          .map((row) => row.id),
      );
      const rows = legs
        .filter((leg) => accountIds.has(leg.accountId))
        .map((leg) => {
          const tx = transactions.find((t) => t.id === leg.transactionId);
          if (tx === undefined) {
            throw new Error('in-memory wallet: transaction missing for leg');
          }
          return {
            legId: leg.id,
            transactionKind: tx.kind,
            refType: tx.refType,
            refId: tx.refId,
            amount: leg.amount,
            balanceAfter: leg.balanceAfter,
            memo: tx.memo,
            createdAt: new Date(),
          };
        })
        .filter((item) =>
          input.kinds && input.kinds.length > 0 ? input.kinds.includes(item.transactionKind) : true,
        )
        .filter((item) => (input.beforeLegId !== undefined ? item.legId < input.beforeLegId : true))
        .toSorted((a, b) => b.legId - a.legId)
        .slice(0, input.limit);
      return Promise.resolve(rows);
    },

    /** 返利流水（postgres adapter 同投影:refType + refId 前缀三类视图;id 倒序分页） */
    listReferralPayouts(_conn, input) {
      let prefix = 'signup:';
      if (input.kind === 'commission') prefix = 'referral-commission:';
      else if (input.kind === 'referral_signup') prefix = 'referral-signup:';
      const refType = input.kind === 'gift' ? 'gift' : 'referral';
      const matched = transactions
        .filter((t) => t.refType === refType && t.refId.startsWith(prefix))
        .toSorted((a, b) => b.id - a.id);
      return Promise.resolve({
        rows: matched.slice(input.offset, input.offset + input.limit).map((t) => ({
          id: t.id,
          kind: t.kind,
          refType: t.refType,
          refId: t.refId,
          memo: t.memo,
          createdAt: new Date(),
        })),
        total: matched.length,
      });
    },

    async verifyInvariants(limit) {
      const violations: Array<{
        kind: 'transaction_balance' | 'account_balance' | 'in_flight';
        key: string;
        detail: string;
      }> = [];
      for (const tx of transactions) {
        const legsOf = legs.filter((l) => l.transactionId === tx.id);
        const sum = legsOf.reduce((acc, l) => acc + Number(l.amount), 0);
        const audit = tx.kind === 'credit_line' || tx.kind === 'freeze';
        if (sum !== 0 || (audit && legsOf.length !== 1) || (!audit && legsOf.length < 2)) {
          violations.push({
            kind: 'transaction_balance',
            key: String(tx.id),
            detail: `legs sum ${sum} kind ${tx.kind}`,
          });
        }
      }
      for (const account of accounts.values()) {
        const own = legs.filter((l) => l.accountId === account.id);
        const lastLeg = own.at(-1);
        const last = lastLeg === undefined ? '0' : lastLeg.balanceAfter;
        if (account.balance !== last) {
          violations.push({
            kind: 'account_balance',
            key: account.id,
            detail: `balance ${account.balance} last leg ${last}`,
          });
        }
        const activeSum = [...authorizations.values()]
          .filter((a) => a.accountId === account.id && a.status === 'active')
          .reduce((acc, a) => acc + Number(a.amount), 0);
        if (Number(account.inFlight) !== activeSum) {
          violations.push({
            kind: 'in_flight',
            key: account.id,
            detail: `in_flight ${account.inFlight} active sum ${activeSum}`,
          });
        }
      }
      return violations.slice(0, limit);
    },

    isUniqueViolation: (error) => {
      let current: unknown = error;
      for (let depth = 0; current != null && depth < 5; depth++) {
        if ((current as { code?: string }).code === '23505') return true;
        current = (current as { cause?: unknown }).cause;
      }
      return false;
    },
  };

  return {
    store,
    suppressNextFindTransaction: () => {
      suppressTransaction = true;
    },
    suppressNextFindAuthorization: () => {
      suppressAuthorization = true;
    },
    freezeUserAccount(userId, currency) {
      for (const row of accounts.values()) {
        if (row.kind === 'user' && row.userId === userId && row.currency === currency) {
          row.status = 'frozen';
        }
      }
    },

    defaceBalanceForTest(userId, currency, balance) {
      for (const row of accounts.values()) {
        if (row.kind === 'user' && row.userId === userId && row.currency === currency) {
          row.balance = balance;
        }
      }
    },

    snapshotForTest(): WalletStoreSnapshot {
      return {
        accounts: structuredClone([...accounts.entries()]),
        authorizations: structuredClone([...authorizations.entries()]),
        transactions: structuredClone(transactions),
        legs: structuredClone(legs),
      };
    },

    restoreForTest(snapshot) {
      accounts.clear();
      for (const [key, row] of snapshot.accounts) accounts.set(key, row);
      authorizations.clear();
      for (const [key, row] of snapshot.authorizations) authorizations.set(key, row);
      transactions.length = 0;
      transactions.push(...snapshot.transactions);
      legs.length = 0;
      legs.push(...snapshot.legs);
    },
  };
}
