import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  paginationQuerySchema,
  paginateQuery,
  paginatedResult,
  parsePagination,
  limitOffset,
} from '../src/pagination/page';
import {
  escapeLike,
  listQuerySchema,
  searchQuerySchema,
  sortQuerySchema,
} from '../src/pagination/list-query';

/**
 * 分页与列表 query（v1 pagination.test 全部 + list-query.test 纯半边迁移）。
 * 容错优先：非法值回退默认、超上限 clamp——分页参数不触发 400。
 */

describe('paginationQuerySchema', () => {
  it('缺省 page=1, page_size=20', () => {
    const r = paginationQuerySchema.parse({});
    expect(r.page).toBe(1);
    expect(r.page_size).toBe(PAGE_SIZE_DEFAULT);
  });

  it('字符串数字 → 强转', () => {
    const r = paginationQuerySchema.parse({ page: '3', page_size: '50' });
    expect(r.page).toBe(3);
    expect(r.page_size).toBe(50);
  });

  it('page_size 超上限 100 → 截断到 100', () => {
    const r = paginationQuerySchema.parse({ page_size: '999' });
    expect(r.page_size).toBe(PAGE_SIZE_MAX);
  });

  it('page=0 / 负数 / 非数字 → 默认 1（catch）', () => {
    expect(paginationQuerySchema.parse({ page: '0' }).page).toBe(1);
    expect(paginationQuerySchema.parse({ page: '-5' }).page).toBe(1);
    expect(paginationQuerySchema.parse({ page: 'abc' }).page).toBe(1);
  });

  it('page_size 非法 → 默认 20', () => {
    expect(paginationQuerySchema.parse({ page_size: 'xyz' }).page_size).toBe(PAGE_SIZE_DEFAULT);
  });
});

describe('parsePagination / limitOffset / paginatedResult', () => {
  it('parsePagination 取值与缺省', () => {
    expect(parsePagination({ page: 4, page_size: 25 })).toEqual({ page: 4, pageSize: 25 });
    expect(parsePagination({})).toEqual({ page: 1, pageSize: PAGE_SIZE_DEFAULT });
  });

  it('limitOffset：第 1 页 offset 0；第 3 页 offset = (3-1)*pageSize', () => {
    expect(limitOffset({ page: 1, pageSize: 20 })).toEqual({ limit: 20, offset: 0 });
    expect(limitOffset({ page: 3, pageSize: 50 })).toEqual({ limit: 50, offset: 100 });
  });

  it('paginatedResult 组装标准结构', () => {
    expect(paginatedResult([1, 2, 3], 100, { page: 2, pageSize: 3 })).toEqual({
      list: [1, 2, 3],
      total: 100,
      page: 2,
      page_size: 3,
    });
  });

  it('paginateQuery：并行两查并组装；count 缺行兜底 0', async () => {
    const r = await paginateQuery(
      { page: 1, pageSize: 2 },
      Promise.resolve(['a', 'b']),
      Promise.resolve([{ count: 7 }]),
    );
    expect(r).toEqual({ list: ['a', 'b'], total: 7, page: 1, page_size: 2 });
    const empty = await paginateQuery(
      { page: 1, pageSize: 2 },
      Promise.resolve([]),
      Promise.resolve([]),
    );
    expect(empty.total).toBe(0);
  });
});

describe('列表 query 组合（sort / search / listQuerySchema）', () => {
  it('sortQuerySchema：order 默认 desc；sort_by trim；可省略', () => {
    expect(sortQuerySchema.parse({})).toEqual({ sort_by: undefined, order: 'desc' });
    expect(sortQuerySchema.parse({ sort_by: 'name', order: 'asc' })).toEqual({
      sort_by: 'name',
      order: 'asc',
    });
    expect(sortQuerySchema.parse({ sort_by: ' name ' })).toEqual({
      sort_by: 'name',
      order: 'desc',
    });
  });

  it('边界：sort_by 超 64 字符 / 搜索词超 100 字符 → 校验拒绝（不静默截断）', () => {
    expect(sortQuerySchema.safeParse({ sort_by: 'x'.repeat(65) }).success).toBe(false);
    expect(searchQuerySchema.safeParse('x'.repeat(101)).success).toBe(false);
    expect(sortQuerySchema.safeParse({ sort_by: 'x'.repeat(64) }).success).toBe(true);
  });

  it('searchQuerySchema：trim、空白/非字符串 → undefined', () => {
    expect(searchQuerySchema.parse(' x ')).toBe('x');
    expect(searchQuerySchema.parse('   ')).toBeUndefined();
    expect(searchQuerySchema.parse(undefined)).toBeUndefined();
  });

  it('listQuerySchema：组合基底缺省形态；差异字段可 extend', () => {
    expect(listQuerySchema.parse({})).toEqual({
      page: 1,
      page_size: 20,
      q: undefined,
      sort_by: undefined,
      order: 'desc',
    });
    const extended = listQuerySchema.extend({ status: z.coerce.number().int().optional() });
    expect(extended.safeParse({ status: '1', page: '2', q: ' x ', sort_by: 'name' })).toMatchObject(
      { success: true, data: { status: 1, page: 2, q: 'x', sort_by: 'name' } },
    );
  });

  it('escapeLike：转义 % _ \\，搜索词按字面匹配', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(escapeLike('普通词')).toBe('普通词');
    expect(escapeLike('')).toBe('');
  });
});
