/**
 * ledger_operations 幂等档案 postgres 适配器：
 * 占位 INSERT（唯一键冲突感知）→ 回读比对 → 回执存档。
 * 操作行与业务写在同一事务：要么同生（执行完成且回执落档）要么同死。
 */
import { eq } from 'drizzle-orm';
import type { DbTx } from '@tillgate/db';
import { ledgerOperations } from '@tillgate/db';
import type { OperationsStore } from '../../ports/operations-store';

export const postgresOperationsStore: OperationsStore = {
  /** 占位：返回新行 id（占位成功，本次执行）；null=已存在（走重放比对） */
  async insertPlaceholder(tx: DbTx, input) {
    const rows = await tx
      .insert(ledgerOperations)
      .values(input)
      .onConflictDoNothing({ target: ledgerOperations.operationId })
      .returning({ id: ledgerOperations.id });
    return rows[0]?.id ?? null;
  },

  async findByOperationId(tx: DbTx, operationId) {
    const [row] = await tx
      .select({
        id: ledgerOperations.id,
        operationId: ledgerOperations.operationId,
        kind: ledgerOperations.kind,
        fingerprint: ledgerOperations.fingerprint,
        receipt: ledgerOperations.receipt,
      })
      .from(ledgerOperations)
      .where(eq(ledgerOperations.operationId, operationId));
    return row ?? null;
  },

  /** 回执存档（执行完成、提交前；与业务写同事务） */
  async saveReceipt(tx: DbTx, id, receipt) {
    await tx
      .update(ledgerOperations)
      .set({ receipt, updatedAt: new Date() })
      .where(eq(ledgerOperations.id, id));
  },
};
