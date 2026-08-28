/**
 * postgres 适配器公共件:ilike 转义与存储时钟。
 * 语义契约见 account-store.ts 头注释。
 */
import { sql } from 'drizzle-orm';

/** ilike 转义:%/_/\ 失去通配义(PG LIKE 默认转义符为反斜杠) */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function likePattern(q: string): string {
  return `%${escapeLikePattern(q)}%`;
}

/** 存储时钟单一来源(写入/过期判定) */
export const nowSql = sql`clock_timestamp()`;
