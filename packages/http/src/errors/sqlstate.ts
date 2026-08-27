/**
 * PG SQLSTATE → http 目录业务错误。
 * 翻译表是 HTTP 边界语义（可预期拒绝不得伪装 500）归 http；
 * cause 链探测实现归 @tillgate/db（pgSqlState），由装配层注入 errorHandler。
 */
import type { BusinessError } from '@tillgate/errors';
import { HttpErrors } from './catalog';

/** 六码翻译表键（目录 key 联合；23505 唯一冲突，FK/CHECK/超长/类型/溢出为值类拒绝） */
type PgKey =
  | 'pg_unique_violation'
  | 'pg_fk_violation'
  | 'pg_check_violation'
  | 'pg_value_too_long'
  | 'pg_invalid_text'
  | 'pg_numeric_out_of_range';

const SQLSTATE_KEYS: Readonly<Record<string, PgKey>> = Object.freeze({
  '23505': 'pg_unique_violation',
  '23503': 'pg_fk_violation',
  '23514': 'pg_check_violation',
  '22001': 'pg_value_too_long',
  '22P02': 'pg_invalid_text',
  '22003': 'pg_numeric_out_of_range',
});

/** SQLSTATE → 目录业务错误（context 携带原 state）；未命中返回 null（非 PG 或不在翻译族） */
export function pgRejection(sqlstate: string | null | undefined): BusinessError | null {
  if (sqlstate == null) return null;
  const key = SQLSTATE_KEYS[sqlstate];
  if (key === undefined) return null;
  return HttpErrors.business(key, { sqlstate });
}
