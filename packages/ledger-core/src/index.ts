/**
 * @ai-gateway/ledger-core — 通用幂等资金操作内核（业务无关）。
 *
 * 与 @ai-gateway/wallet 的分工：wallet 是钱的真相（账户/流水/冻结）；本包是
 * 「业务操作」的真相——operationId 幂等键 + canonical 指纹 + 回执重放。
 * 消费方在 execute(tx) 里做业务状态机写 + wallet 动词（tx 注入），同生共死；
 * 重试风暴/回调重放/崩溃恢复下，同键至多一次 execute。
 *
 * 也可独立承载纯业务幂等（不碰钱的操作同样需要「至多一次+回执」语义）。
 */

// 装配与契约
export { createLedger } from './ledger.js';
export type {
  CreateLedgerOptions,
  Ledger,
  LedgerEffects,
  OperationReceipt,
  OperationView,
  RunOperationInput,
  RunOperationResult,
  ListOperationsInput,
  ListOperationsResult,
} from './types.js';

// 指纹工具（消费方对业务参数做规范指纹时复用；run 内部同源）
export { canonicalJson, fingerprintOf } from './fingerprint.js';

// 错误（全部类型化；code 全局唯一，边界层按 code 翻译 HTTP）
export {
  LedgerCoreError,
  InvalidInputError,
  UnknownOperationKindError,
  InvalidOperationIdError,
  OperationConflictError,
  LedgerInternalError,
} from './errors.js';

// schema 与建表
export { provision, provisionSql, deprovision, ledgerOperations } from './schema.js';
