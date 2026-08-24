/**
 * 事务执行壳与事务级 advisory lock。
 *
 * v1 三份逐字拷贝(wallet 带 telemetry / ledger-core / identity-core)收敛为单份(D1):
 * 重试魔法数(尝试 5、退避 15·2^attempt、抖动 rand(0..20))显式化为必填策略——
 * 行为等价值 = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 }。
 *
 * 重试安全的前提是动词幂等(唯一索引 + 重放读回,调用方设计责任):
 * 重试后撞唯一键走重放路径。注入 tx 句柄时 drizzle transaction() 退化为事务内
 * SAVEPOINT——提交/回滚权归调用方,唯一冲突只回滚到 savepoint(外层事务不受损)。
 */
import { sql } from 'drizzle-orm';
import type { Db, DbTx } from './client.js';
import type { DbLike } from './context.js';
import { transientTxFailureCode } from './pg-error.js';

/** 重试策略(必填注入,铁律 3;装配缺省值归 app config schema) */
export interface TxRetryPolicy {
  /** 总尝试次数上限(v1 等价 = 5) */
  readonly maxAttempts: number;
  /** 退避基数毫秒(v1 等价 = 15;第 n 次重试前延迟 = base · 2^(n-1)) */
  readonly baseDelayMs: number;
  /** 抖动上限毫秒,半开区间 [0, maxJitterMs)(v1 等价 = 20) */
  readonly maxJitterMs: number;
}

/** 观测钩子(可选):重试发生时通知;钩子异常吞掉——观测系统不可参与资金决策(v1 wallet 语义) */
export interface TxRetryHooks {
  onRetry?(info: { attempt: number; code: '40P01' | '40001' }): void;
}

// eslint-disable-next-line max-params -- 跨包导出 API，policy/hooks 为必填策略与可选观测，改 options 对象会波及全仓调用点（手册 §3）
export async function runTx<T>(
  db: Db,
  fn: (tx: DbTx) => Promise<T>,
  policy: TxRetryPolicy,
  hooks?: TxRetryHooks,
): Promise<T>;
// eslint-disable-next-line max-params -- 同上：重载声明，参数面与实现一致
export async function runTx<T>(
  db: DbTx,
  fn: (tx: DbTx) => Promise<T>,
  policy: TxRetryPolicy,
  hooks?: TxRetryHooks,
): Promise<T>;
// eslint-disable-next-line max-params -- 同上：实现签名
export async function runTx<T>(
  db: DbLike,
  fn: (tx: DbTx) => Promise<T>,
  policy: TxRetryPolicy,
  hooks?: TxRetryHooks,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await (db as Db).transaction(fn);
    } catch (error) {
      const code = transientTxFailureCode(error);
      if (attempt + 1 >= policy.maxAttempts || !code) throw error;
      try {
        hooks?.onRetry?.({ attempt: attempt + 1, code });
      } catch {
        // 观测失败不得改变资金路径行为。
      }
      await new Promise((resolve) => {
        setTimeout(
          resolve,
          policy.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * policy.maxJitterMs),
        );
      });
    }
  }
}

/**
 * 事务级 advisory lock(DB 层串行原语,随事务终结自动释放):
 * 跨表不变量(如「凭据集非空」)无法用 CHECK 表达时,用同键串行化消灭竞态窗口。
 * 锁键命名是业务语义(如 identity.user:{id}),由调用方构造——v1 的键构造器归 identity 包(C8)。
 */
export async function advisoryLock(db: DbLike, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}
