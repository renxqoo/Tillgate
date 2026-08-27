/**
 * 幂等操作用例：占位 → 执行 → 回执存档 / 重放（ledger_operations 档案）。
 *
 *   run({ operationId, kind, payload, execute(tx) }) → { receipt, replayed }
 *
 * 语义：同 operationId + 同 canonical 指纹 → 重放首次回执；
 *       同 operationId + 异指纹 → idempotency_conflict（409）。
 * 操作行与 execute 的业务写在同一事务（调用方传入 tx 或本用例自开）。
 */
import { DefectError } from '@tillgate/errors';
import { BillingErrors } from '../domain/errors.js';
import { assertCommandFingerprint, commandFingerprint } from '../domain/fingerprint.js';
import type { FingerprintValue } from '../domain/fingerprint.js';
import type { BillingStore } from '../ports/billing-store.js';
import type { WalletTx } from '../ports/wallet-store.js';

/** 回执序列化上限（16KB——超限即缺陷：回执是重放凭据不是数据仓库） */
const MAX_RECEIPT_BYTES = 16_384;

/** operationId 契约（1-128 位可见标识符；词表校验在 domain） */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw BillingErrors.business('invalid_ref', {
      reason: 'invalid_operation_id',
      operationId,
    });
  }
}

export interface OperationRun<T> {
  operationId: string;
  kind: string;
  /** 业务参数（canonical 指纹输入；同键不同参 = 冲突）。严格指纹：非 JSON 安全值拒绝 */
  payload: Record<string, FingerprintValue>;
  execute: (tx: WalletTx) => Promise<T>;
  /** 加入调用方事务（可选；缺省自开） */
  tx?: WalletTx;
}

// eslint-disable-next-line max-lines-per-function -- 运营用例事务体:顺序步骤
export function createOperationsUseCase(env: { store: BillingStore }) {
  const { store } = env;
  // eslint-disable-next-line max-lines-per-function -- 运营用例事务体:顺序步骤
  async function run<T extends Record<string, unknown>>(
    input: OperationRun<T>,
  ): Promise<{ receipt: T; replayed: boolean }> {
    assertOperationId(input.operationId);
    const fingerprint = commandFingerprint(input.kind, input.payload);

    const execute = async (tx: WalletTx): Promise<{ receipt: T; replayed: boolean }> => {
      const placeholderId = await store.insertOperationPlaceholder(tx, {
        operationId: input.operationId,
        kind: input.kind,
        fingerprint,
      });
      if (placeholderId != null) {
        const receipt = await input.execute(tx);
        if (JSON.stringify(receipt).length > MAX_RECEIPT_BYTES) {
          throw new DefectError(
            `operation receipt exceeds ${MAX_RECEIPT_BYTES} bytes`,
            'billing.operation_receipt_oversize',
            { operationId: input.operationId },
          );
        }
        await store.saveOperationReceipt(tx, placeholderId, receipt);
        return { receipt, replayed: false };
      }
      const existing = await store.findOperation(tx, input.operationId);
      if (!existing || existing.fingerprint !== fingerprint) {
        throw BillingErrors.business('idempotency_conflict', {
          refType: 'operation',
          refId: input.operationId,
          kind: input.kind,
        });
      }
      assertCommandFingerprint(existing.fingerprint, fingerprint, {
        refType: 'operation',
        refId: input.operationId,
        kind: input.kind,
      });
      // 占位与回执同事务写：提交行必有回执；此处 receipt 为 null 即并发未提交对手
      // （唯一索引等待语义保证读到的是已提交行），红灯兜底
      if (existing.receipt == null) {
        throw new DefectError(
          'operation receipt missing after commit',
          'billing.operation_receipt_missing',
          { operationId: input.operationId },
        );
      }
      return { receipt: existing.receipt as T, replayed: true };
    };

    if (input.tx) return execute(input.tx);
    return store.transaction(execute);
  }

  return { run };
}
