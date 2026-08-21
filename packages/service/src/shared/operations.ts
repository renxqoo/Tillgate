/**
 * 幂等操作用例：占位 → 执行 → 回执存档 / 重放。
 *
 *   run({ operationId, kind, payload, execute(tx) })
 *     → { receipt, replayed }
 *
 * 语义：同 operationId + 同 canonical 指纹 → 重放首次回执；
 *       同 operationId + 异指纹 → OperationConflictError（409）。
 * 操作行与 execute 的业务写在同一事务（调用方传入 tx 或本用例自开）。
 */
import type { Db, DbTx } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import { assertOperationId } from '@ai-gateway/domain';
import { OperationConflictError } from '@ai-gateway/domain';
import { commandFingerprint } from '@ai-gateway/domain';

export interface OperationsEnv {
  db: Db;
  /** 仓储注入（缺省进程级默认实例） */
  repos?: Repositories;
}

export interface OperationRun<T> {
  operationId: string;
  kind: string;
  /** 业务参数（canonical 指纹输入；同键不同参 = 冲突） */
  payload: Record<string, unknown>;
  execute: (tx: DbTx) => Promise<T>;
  /** 加入调用方事务（可选；缺省自开） */
  tx?: DbTx;
}

export function createOperationsUseCase(env: OperationsEnv) {
  const { db } = env;
  const repos = env.repos ?? createRepositories();
  async function run<T extends Record<string, unknown>>(
    ctx: RunContext,
    input: OperationRun<T>,
  ): Promise<{ receipt: T; replayed: boolean }> {
    assertOperationId(input.operationId);
    const fingerprint = commandFingerprint(input.kind, input.payload as Parameters<typeof commandFingerprint>[1]);

    const execute = async (tx: DbTx): Promise<{ receipt: T; replayed: boolean }> => {
      const c = inTx(ctx, tx);
      const placeholderId = await repos.operations.insertPlaceholder(c, {
        operationId: input.operationId,
        kind: input.kind,
        fingerprint,
      });
      if (placeholderId != null) {
        const receipt = await input.execute(tx);
        await repos.operations.saveReceipt(c, placeholderId, receipt);
        return { receipt, replayed: false };
      }
      const existing = await repos.operations.findByOperationId(c, input.operationId);
      if (!existing || existing.fingerprint !== fingerprint) {
        throw new OperationConflictError(input.operationId);
      }
      // 占位与回执同事务写：提交行必有回执；此处 receipt 为 null 即并发未提交对手
      // （唯一索引等待语义保证读到的是已提交行），红灯兜底
      return { receipt: existing.receipt as T, replayed: true };
    };

    if (input.tx) return execute(input.tx);
    return db.transaction(execute);
  }

  return { run };
}
