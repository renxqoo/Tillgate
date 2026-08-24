/**
 * OperationsStore port：幂等操作档案（ledger_operations）的持久化边界。
 * 操作行与业务写在同一事务：要么同生（执行完成且回执落档）要么同死（execute 抛错整体回滚）。
 * 幂等键全局唯一——并发同键的第二个 INSERT 阻塞在索引上直到首个事务终结。
 */
import type { DbTx } from '@tillgate/db';

export interface OperationsStore {
  /** 占位（同键已存在返回 null——调用方走重放/冲突路径） */
  insertPlaceholder(
    tx: DbTx,
    input: { operationId: string; kind: string; fingerprint: string },
  ): Promise<number | null>;
  findByOperationId(
    tx: DbTx,
    operationId: string,
  ): Promise<{ fingerprint: string; receipt: unknown } | null>;
  saveReceipt(tx: DbTx, placeholderId: number, receipt: Record<string, unknown>): Promise<void>;
}
