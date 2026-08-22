/**
 * 边界兜底：任意 unknown → 规范化错误记录（DESIGN §2）。
 * 根契约错误原样成录；外来 Error / 非 Error 值一律按缺陷（errors.unhandled / errors.non_error）。
 * 协议细节（PG/Redis/厂商）不在此层——由各所有者在源头分类后用根类表达（ADR-0001 §4）。
 */
import { recordOfUnknown, type ErrorRecord } from './error-record';

export function normalizeError(error: unknown): ErrorRecord {
  return recordOfUnknown(error);
}
