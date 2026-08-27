/**
 * 边界兜底：任意 unknown → 规范化错误记录。
 * 根契约错误原样成录；外来 Error / 非 Error 值一律按缺陷（errors.unhandled / errors.non_error）。
 * 协议细节（PG/Redis/厂商）不在此层——由各所有者在源头分类后用根类表达。
 */
import { recordOfUnknown, type ErrorRecord } from './error-record';

/** 参数可选:缺省与 undefined 同录为 errors.non_error(非错误值兜底语义) */
export function normalizeError(error?: unknown): ErrorRecord {
  return recordOfUnknown(error);
}
