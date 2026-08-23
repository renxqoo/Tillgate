/**
 * 幂等操作壳（v1 operations use case 语义等价迁移）：
 * 占位 → 执行 → 回执存档 / 重放。同 operationId + 同 canonical 指纹 → 重放首次回执；
 * 同 operationId + 异指纹 → operation_conflict。操作行与业务写在同一事务。
 */
import type { Db, DbTx } from '@tokenlens/db';
import { DefectError } from '@tokenlens/errors';
import type { OperationsStore } from '../../ports/operations-store';
import {
  assertOperationId,
  commandFingerprint,
  type CanonicalObject,
} from '../../domain/operation';
import { controlPlaneErrors } from '../../errors';
import type { ControlContext } from '../context';

export interface RunOperationDeps {
  readonly db: Db;
  readonly stores: { readonly operations: OperationsStore };
}

export interface OperationRun<T extends Record<string, unknown>> {
  readonly ctx: ControlContext;
  readonly operationId: string;
  readonly kind: string;
  /** 业务参数（canonical 指纹输入；同键不同参 = 冲突） */
  readonly payload: CanonicalObject;
  execute: (tx: DbTx) => Promise<T>;
}

export async function runOperation<T extends Record<string, unknown>>(
  deps: RunOperationDeps,
  input: OperationRun<T>,
): Promise<{ receipt: T; replayed: boolean }> {
  assertOperationId(input.operationId);
  const fingerprint = commandFingerprint(input.kind, input.payload);

  return deps.db.transaction(async (tx) => {
    const placeholderId = await deps.stores.operations.insertPlaceholder(tx, {
      operationId: input.operationId,
      kind: input.kind,
      fingerprint,
    });
    if (placeholderId != null) {
      const receipt = await input.execute(tx);
      await deps.stores.operations.saveReceipt(tx, placeholderId, receipt);
      return { receipt, replayed: false };
    }
    const existing = await deps.stores.operations.findByOperationId(tx, input.operationId);
    if (!existing || existing.fingerprint !== fingerprint) {
      throw controlPlaneErrors.business('operation_conflict', { operationId: input.operationId });
    }
    // 占位与回执同事务写：提交行必有回执；receipt 为 null 即「占位已提交但回执缺失」，
    // 违反不变量——不得伪造空回执糊弄调用方（原 `as T` 红灯兜底会把缺陷漏成脏数据），
    // 按 defect 显式红灯（AGENT.md §11 源头分类）
    if (existing.receipt == null) {
      throw new DefectError(
        'operation receipt missing on committed placeholder (fingerprint matched)',
        'control_plane.operation_receipt_missing',
        { operationId: input.operationId, kind: input.kind },
      );
    }
    return { receipt: existing.receipt as T, replayed: true };
  });
}
