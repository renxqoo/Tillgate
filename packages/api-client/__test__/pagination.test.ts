/**
 * buildListQuery 行为规格(v1 list.ts 纯函数部分;查询参数名与跳过规则不变)。
 */
import { describe, expect, it } from 'vitest';
import { buildListQuery } from '../src/core/pagination';

describe('buildListQuery', () => {
  it('page/limit 必出;page 缺省 1', () => {
    expect(buildListQuery({ pageSize: 20 })).toBe('page=1&limit=20');
    expect(buildListQuery({ page: 3, pageSize: 20 })).toBe('page=3&limit=20');
  });

  it('sortBy 才追加 sort_by + order(order 缺省 desc)', () => {
    expect(buildListQuery({ pageSize: 10, sortBy: 'created_at' })).toBe(
      'page=1&limit=10&sort_by=created_at&order=desc',
    );
    expect(buildListQuery({ pageSize: 10, sortBy: 'created_at', order: 'asc' })).toBe(
      'page=1&limit=10&sort_by=created_at&order=asc',
    );
  });

  it('extra 跳过 undefined 与空串,保留数字 0', () => {
    const query = buildListQuery({
      pageSize: 10,
      extra: { status: 0, keyword: '', providerId: 7, userId: undefined },
    });
    expect(query).toBe('page=1&limit=10&status=0&providerId=7');
  });
});
