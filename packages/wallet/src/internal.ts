/** 内部共享：事务句柄类型与唯一冲突识别（不对外导出语义） */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { WalletTelemetry } from './types';

/**
 * 任意 schema 绑定的 PG 库句柄（消费方持 schema-bound Db 直传；
 * drizzle 泛型不变性下 NodePgDatabase<Record<string,never>> 收不了，同 ledger-core）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPgDatabase = NodePgDatabase<any>;

/** 事务句柄（drizzle tx 与 db 同构子集） */
export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export type DbLike = NodePgDatabase | Tx;

/** PG 唯一约束冲突（并发重放双保险的兜底信号）——drizzle 会包一层 cause，逐层探查 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 瞬态事务错误（PG 死锁 40P01 / 串行化失败 40001）——幂等动词可安全重试 */
function transientTxCode(error: unknown): '40P01' | '40001' | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const code = (current as { code?: string }).code;
    if (code === '40P01' || code === '40001') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * 事务执行壳：瞬态死锁/串行化冲突自动重试（5 次，指数退避 + 抖动）。
 * 动词幂等（唯一索引 + 重放读回）保证重试安全——重试后撞唯一键走重放路径。
 *
 * db 为注入的事务句柄时 transaction() 退化为事务内 SAVEPOINT：提交/回滚权归
 * 调用方；唯一冲突只回滚到 savepoint（外层事务不受损），随后由动词的重放
 * 路径接管——注入与否，并发同键语义完全一致。
 */
export async function runTx<T>(
  db: DbLike,
  fn: (tx: Tx) => Promise<T>,
  telemetry?: WalletTelemetry,
  operation = 'wallet',
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(fn);
    } catch (error) {
      const code = transientTxCode(error);
      if (attempt >= 4 || !code) throw error;
      try {
        telemetry?.onTransactionRetry?.({ operation, attempt: attempt + 1, code });
      } catch {
        // 观测系统不可参与资金决策。
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 15 * 2 ** attempt + Math.floor(Math.random() * 20)),
      );
    }
  }
}
