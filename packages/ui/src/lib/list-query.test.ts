import { describe, expect, it } from 'vitest';
import { firstParam, listHref } from './list-query.js';

describe('listHref', () => {
  it('空参数 → 空串（不带 ?）', () => {
    expect(listHref({})).toBe('');
    expect(listHref({ q: undefined, page: '' })).toBe('');
  });

  it('保留现有筛选，数组参数逐个追加', () => {
    expect(listHref({ q: 'gpt', status: '1' })).toBe('?q=gpt&status=1');
    expect(listHref({ tag: ['a', 'b'] })).toBe('?tag=a&tag=b');
  });

  it('覆盖参数：字符串/数字生效，空值删除', () => {
    expect(listHref({ q: 'a', page: '3' }, { page: 1 })).toBe('?q=a&page=1');
    expect(listHref({ q: 'a', page: '3' }, { page: undefined })).toBe('?q=a');
    expect(listHref({ q: 'a', status: '1' }, { q: '', status: null })).toBe('');
  });

  it('排序跳转：覆盖 sort_by/order 并回到第 1 页', () => {
    const href = listHref(
      { q: 'x', page: '5', sort_by: 'createdAt', order: 'desc' },
      { sort_by: 'createdAt', order: 'asc', page: 1 },
    );
    const sp = new URLSearchParams(href.slice(1));
    expect(sp.get('q')).toBe('x');
    expect(sp.get('page')).toBe('1');
    expect(sp.get('sort_by')).toBe('createdAt');
    expect(sp.get('order')).toBe('asc');
  });
});

describe('firstParam', () => {
  it('取第一个值；undefined/空串 → undefined', () => {
    expect(firstParam('a')).toBe('a');
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam('')).toBeUndefined();
  });
});
