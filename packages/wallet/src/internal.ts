/** 内部共享：事务句柄类型与唯一冲突识别（不对外导出语义） */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

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
