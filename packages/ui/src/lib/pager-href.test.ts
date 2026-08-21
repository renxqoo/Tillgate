import { describe, expect, it } from 'vitest';
import { pagerHref } from './pager-href.js';

/**
 * 分页键回归：pageKey 必须可指定——同页双列表（tpage/apage）场景下，若页码键
 * 硬编码 page，页面读 tpage、点分页发出 ?page=N，参数名对不上、翻页无效；
 * 默认 page 保持单列表页行为不变。
 */
describe('pagerHref pageKey', () => {
  it('默认键 page：保留筛选参数', () => {
    expect(pagerHref({ q: 'x' }, 'page', 2)).toBe('?q=x&page=2');
  });

  it('pageKey="tpage"：页码写入 tpage，其余参数保留', () => {
    expect(
      pagerHref(
        { apage: '1', from: '2026-01-01', sort_by: 'createdAt', order: 'desc' },
        'tpage',
        5,
      ),
    ).toBe('?apage=1&from=2026-01-01&sort_by=createdAt&order=desc&tpage=5');
  });

  it('空值参数跳过', () => {
    expect(pagerHref({ q: undefined, tpage: '' }, 'apage', 2)).toBe('?apage=2');
  });
});
