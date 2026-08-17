/** 内部共享：事务句柄类型与瞬态重试壳（不对外导出语义） */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** 事务句柄（drizzle tx 与 db 同构子集） */
export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export type DbLike = NodePgDatabase | Tx;

/** 瞬态事务错误（PG 死锁 40P01 / 串行化失败 40001）——幂等动词可安全重试 */
function transientTxCode(error: unknown): '40P01' | '40001' | undefined {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const code = (current as { code?: string }).code;
    if (code === '40P01' || code === '40001') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * 事务执行壳：瞬态死锁/串行化冲突自动重试（5 次，指数退避 + 抖动）。
 * 不同 operationId 的 execute 可能以不同顺序触碰同一批业务行——死锁是常态而非异常，
 * 幂等性（唯一索引 + 重放读回）保证重试后要么执行要么重放，资金语义不变。
 */
export async function runTx<T>(db: NodePgDatabase, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(fn);
    } catch (error) {
      const code = transientTxCode(error);
      if (attempt >= 4 || !code) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 15 * 2 ** attempt + Math.floor(Math.random() * 20)),
      );
    }
  }
}

/** 尽力而为效应（提交后的观测类副作用）：失败吞掉，绝不影响已提交的结果 */
export async function runEffect(effect: (() => Promise<void> | undefined) | undefined): Promise<void> {
  if (!effect) return;
  try {
    await effect();
  } catch {
    // PostgreSQL 已提交；观测失败不能改变安全结果。
  }
}
