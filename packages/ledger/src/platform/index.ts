/**
 * @ai-gateway/ledger/platform —— 域公共底座：错误单一家谱 / HTTP 映射 / 幂等执行器。
 * 被所有域引用；不依赖任何域（依赖铁律的根）。
 */
export * from './errors.js';
export { LEDGER_HTTP, ledgerHttpError } from './http.js';
export type { LedgerHttpMapping } from './http.js';
export { createDomainOperations } from './operations.js';
export type { DomainOperations, DomainTx } from './operations.js';

