/**
 * 幂等操作档案仓储（ledger_operations）：
 * 占位 INSERT（唯一键冲突感知）→ 回读比对 → 回执存档。
 * 操作行与业务写在同一事务：要么同生（执行完成且回执落档）要么同死。
 */
import { eq } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { ledgerOperations } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

export interface OperationRow {
  id: number;
  operationId: string;
  kind: string;
  fingerprint: string;
  receipt: unknown;
}

/** 幂等档案仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class OperationsRepository {
  /** 占位：返回新行 id（占位成功，本次执行）；null=已存在（走重放比对） */
  async insertPlaceholder(
    c: RepoContext,
    input: { operationId: string; kind: string; fingerprint: string },
  ): Promise<number | null> {
    const rows = await tx(c)
      .insert(ledgerOperations)
      .values(input)
      .onConflictDoNothing({ target: ledgerOperations.operationId })
      .returning({ id: ledgerOperations.id });
    return rows[0]?.id ?? null;
  }

  async findByOperationId(c: RepoContext, operationId: string): Promise<OperationRow | null> {
    const [row] = await c.db
      .select({
        id: ledgerOperations.id,
        operationId: ledgerOperations.operationId,
        kind: ledgerOperations.kind,
        fingerprint: ledgerOperations.fingerprint,
        receipt: ledgerOperations.receipt,
      })
      .from(ledgerOperations)
      .where(eq(ledgerOperations.operationId, operationId));
    return (row as OperationRow) ?? null;
  }

  /** 回执存档（执行完成、提交前；与业务写同事务） */
  async saveReceipt(c: RepoContext, id: number, receipt: unknown): Promise<void> {
    await tx(c)
      .update(ledgerOperations)
      .set({ receipt: receipt as object, updatedAt: new Date() })
      .where(eq(ledgerOperations.id, id));
  }
}
