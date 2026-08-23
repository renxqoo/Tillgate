/**
 * 管理面契约基底（v1 http/money-schema.ts + list-query.ts 语义收口）：
 *   - 金额一律十进制字符串（禁 IEEE-754 number）；上限 1e9 与 v1 同值；
 *   - 统一列表契约:?page&page_size≤100&q&sort_by&order;白名单外 400;
 *   - 信封 {rows,total,page,pageSize}(v1 键名——前端 fetchAdminList 消费口径)。
 */
import { z } from 'zod';
import { Decimal, parseNonNegativeAmount, parsePositiveAmount } from '@tokenlens/billing';
import { listQuerySchema } from '@tokenlens/http';
import { AdminErrors } from '../error-face';

const MONEY_MAX = new Decimal('1000000000');

function validPositive(raw: string): boolean {
  try {
    return parsePositiveAmount(raw).lte(MONEY_MAX);
  } catch {
    return false;
  }
}

function validNonNegative(raw: string): boolean {
  try {
    return parseNonNegativeAmount(raw).lte(MONEY_MAX);
  } catch {
    return false;
  }
}

function validSignedNonZero(raw: string): boolean {
  if (!/^-?\d{1,20}(?:\.\d{1,18})?$/.test(raw)) return false;
  const magnitude = raw.startsWith('-') ? raw.slice(1) : raw;
  return validPositive(magnitude);
}

export const positiveMoneyString = z
  .string()
  .refine(validPositive, 'Amount must be a valid positive decimal string within the limit');
export const nonNegativeMoneyString = z
  .string()
  .refine(validNonNegative, 'Amount must be a valid non-negative decimal string within the limit');
export const signedNonZeroMoneyString = z
  .string()
  .refine(validSignedNonZero, 'Amount must be a valid non-zero decimal string within the limit');

/** 路径参数 id：正整数（v1 idParam 语义 → admin.invalid_param） */
export function idParam(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw AdminErrors.business('invalid_param', {
      field: 'id',
      reason: 'must be a positive integer',
    });
  }
  return id;
}

export interface ListParts {
  q?: string;
  sortBy: string;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

/**
 * 统一列表查询解析（v1 parseListQuery 语义）：分页/搜索由 @tokenlens/http
 * listQuerySchema 容错解析（非法值回退缺省,永不 400）；sort_by 缺省 defaultSort,
 * 白名单外 → 400 admin.invalid_sort_field（不静默回退——v1 语义）。
 */
export function parseListQuery(
  query: Record<string, string | string[] | undefined>,
  sortWhitelist: readonly string[],
  defaultSort: string,
): ListParts {
  const parsed = listQuerySchema.parse(query);
  const sortBy = parsed.sort_by ?? defaultSort;
  if (!sortWhitelist.includes(sortBy)) {
    throw AdminErrors.business('invalid_sort_field', {
      field: sortBy,
      allowed: sortWhitelist.join(','),
    });
  }
  return {
    q: parsed.q,
    sortBy,
    order: parsed.order,
    page: parsed.page,
    pageSize: parsed.page_size,
    limit: parsed.page_size,
    offset: (parsed.page - 1) * parsed.page_size,
  };
}

/** 列表信封（v1 键名 rows/pageSize;rows 收窄只读面） */
export function listEnvelope<T>(
  rows: readonly T[],
  total: number,
  parts: ListParts,
): {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
} {
  return { rows: [...rows], total, page: parts.page, pageSize: parts.pageSize };
}

/** Date → ISO 字符串（wire 一律字符串） */
export function iso(date: Date | null | undefined): string | null {
  return date == null ? null : date.toISOString();
}
