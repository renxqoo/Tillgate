/** 内部共享：事务句柄类型、唯一冲突识别、advisory lock、瞬态重试壳（不对外导出语义） */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** 事务句柄（drizzle tx 与 db 同构子集） */
export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/** 库侧宽容数据库类型：消费方传入业务 schema 绑定的 Db/Tx 也可（drizzle 泛型不变性兼容） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lib 边界：接受任意 schema 绑定
export type AnyPgDatabase = NodePgDatabase<any>;

export type DbLike = AnyPgDatabase | Tx;

/**
 * PG 唯一约束冲突的约束名（并发路径的兜底信号）——drizzle 会包一层 cause，逐层探查。
 * 返回冲突命中的约束名；非唯一冲突返回 null。
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if ((current as { code?: string }).code === '23505') {
      return (current as { constraint?: string }).constraint ?? '';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

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

/** 事务执行壳：瞬态死锁/串行化冲突自动重试（5 次，指数退避 + 抖动） */
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

/**
 * 事务级 advisory lock（DB 层串行原语，随事务终结自动释放）：
 * 跨表不变量（如「凭据集非空」）无法用 CHECK 表达，用同键串行化消灭竞态窗口。
 */
export async function advisoryLock(dbLike: DbLike, key: string): Promise<void> {
  await dbLike.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/** 凭据集串行键：该用户的「登录方式集合」变更（挂凭据/绑解绑/密码增删）全部互斥 */
export function credentialSetLockKey(userId: number): string {
  return `identity.user:${userId}`;
}

/** 挑战串行键：同 kind 同目标的发码互斥（冷却判定与替换在锁内成为原子决策） */
export function challengeLockKey(kind: string, targetKey: string): string {
  return `identity.challenge:${kind}:${targetKey}`;
}

/** 尽力而为效应（提交后的观测类副作用）：失败吞掉，绝不影响已提交的安全结果 */
export async function runEffect(effect: (() => Promise<void> | undefined) | undefined): Promise<void> {
  if (!effect) return;
  try {
    await effect();
  } catch {
    // PostgreSQL 已提交；观测失败不能改变安全结果。
  }
}
