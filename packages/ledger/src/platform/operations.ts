/**
 * platform/operations：域幂等执行器——ledger-core.run 的域侧薄包装。
 *
 * 承担「占位→回读→指纹核对→回执存档」；冲突翻译为 LedgerError('idempotency_conflict')
 * 保住既有 HTTP 409 契约。各域（subscription/channel-budget/billing）用本工厂
 * 建自己的 kinds 白名单实例（fail-closed），execute 内做业务状态机写 +
 * wallet 动词（tx 注入）同生共死。
 */
import type { Db } from '@ai-gateway/db';
import { createLedger as createLedgerCore, OperationConflictError } from '@ai-gateway/ledger-core';
import type { OperationReceipt } from '@ai-gateway/ledger-core';
import { LedgerError } from './errors.js';

/** 业务事务句柄（schema 绑定；execute 回调在此类型上执行业务写与 wallet 动词） */
export type DomainTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DomainOperations {
  run<T extends OperationReceipt>(input: {
    operationId: string;
    kind: string;
    /** 业务参数指纹（canonical；同键不同参 = 409 冲突） */
    fingerprint: unknown;
    execute: (tx: DomainTx) => Promise<T>;
  }): Promise<{ receipt: T; replayed: boolean }>;
}

export function createDomainOperations(db: Db, kinds: readonly string[]): DomainOperations {
  const core = createLedgerCore(db, { kinds: [...kinds] });
  async function run<T extends OperationReceipt>(input: {
    operationId: string;
    kind: string;
    /** 业务参数指纹（canonical；同键不同参 = 409 冲突） */
    fingerprint: unknown;
    execute: (tx: DomainTx) => Promise<T>;
  }): Promise<{ receipt: T; replayed: boolean }> {
    try {
      const outcome = await core.run({
        operationId: input.operationId,
        kind: input.kind,
        fingerprint: input.fingerprint,
        execute: (coreTx) =>
          input.execute(coreTx as unknown as DomainTx) as Promise<OperationReceipt>,
      });
      return { receipt: outcome.receipt as T, replayed: outcome.replayed };
    } catch (error) {
      if (error instanceof OperationConflictError) {
        throw new LedgerError('idempotency_conflict');
      }
      throw error;
    }
  }
  return { run };
}
