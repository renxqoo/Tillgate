import { describe, expect, it } from 'vitest';
import {
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
  PAGE_SIZE_MAX,
  PAGE_SIZE_DEFAULT,
} from '../pagination.js';

describe('pagination', () => {
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

  describe('parsePagination', () => {
    it('取值', () => {
      const p = parsePagination({ page: 4, page_size: 25 });
      expect(p).toEqual({ page: 4, pageSize: 25 });
    });
    it('缺省', () => {
      const p = parsePagination({});
      expect(p).toEqual({ page: 1, pageSize: PAGE_SIZE_DEFAULT });
    });
  });

  describe('limitOffset', () => {
    it('第 1 页 offset 0', () => {
      expect(limitOffset({ page: 1, pageSize: 20 })).toEqual({ limit: 20, offset: 0 });
    });
    it('第 3 页 offset = (3-1)*pageSize', () => {
      expect(limitOffset({ page: 3, pageSize: 50 })).toEqual({ limit: 50, offset: 100 });
    });
  });

  describe('paginatedResult', () => {
    it('组装标准结构', () => {
      const r = paginatedResult([1, 2, 3], 100, { page: 2, pageSize: 3 });
      expect(r).toEqual({ list: [1, 2, 3], total: 100, page: 2, page_size: 3 });
    });
  });
});
