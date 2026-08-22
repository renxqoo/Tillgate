/**
 * 通用分页组件（v1 pagination.ts 逐字迁移；api-contract §4：统一 ?page=&page_size=）。
 *
 * 约定：
 *   - page 从 1 开始（0/负数按 1 处理）
 *   - page_size 上限 100（防超大查询拖垮 DB）
 *   - 返回 {list, total, page, page_size} 标准结构
 */
import { z } from 'zod';

export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 20;

/**
 * 分页 query schema（GET 接口共用，可与其他字段联合 extend）。
 * 容错优先：page/page_size 的非法值一律回退默认（catch），不让分页参数触发 400。
 * page_size 超上限时 clamp 到上限（而非报错）——大页请求降级为最大页，对调用方更友好。
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  page_size: z.preprocess(
    (v) => {
      const n = typeof v === 'string' ? Number(v) : (v as number);
      if (!Number.isFinite(n) || n < 1) return PAGE_SIZE_DEFAULT;
      return Math.min(Math.floor(n), PAGE_SIZE_MAX);
    },
    z.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  ),
});

export interface PaginationParams {
  page: number;
  pageSize: number;
}

/** 从校验后的 query 取规范化的分页参数 */
export function parsePagination(q: { page?: number; page_size?: number }): PaginationParams {
  return {
    page: q.page ?? 1,
    pageSize: q.page_size ?? PAGE_SIZE_DEFAULT,
  };
}

/** limit/offset 计算（offset 从 0 开始） */
export function limitOffset(p: PaginationParams): { limit: number; offset: number } {
  return { limit: p.pageSize, offset: (p.page - 1) * p.pageSize };
}

export interface PaginatedResult<T> {
  list: T[];
  total: number;
  page: number;
  page_size: number;
}

export function paginatedResult<T>(list: T[], total: number, p: PaginationParams): PaginatedResult<T> {
  return { list, total, page: p.page, page_size: p.pageSize };
}

/**
 * 一次性执行「列表 + 计数」两个查询并组装标准分页响应（调用方喂两个已发起的 Promise），
 * 消除各路由重复的 Promise.all + count 取值样板。
 */
export async function paginateQuery<T>(
  p: PaginationParams,
  listQuery: Promise<T[]>,
  countQuery: Promise<Array<{ count: number }>>,
): Promise<PaginatedResult<T>> {
  const [list, countRows] = await Promise.all([listQuery, countQuery]);
  return paginatedResult(list, Number(countRows[0]?.count ?? 0), p);
}
