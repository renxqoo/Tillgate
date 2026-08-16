import { describe, expect, it } from 'vitest';
import { integer, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { resolveOrderBy } from '../list-query.js';

/**
 * 回归锁（new-api #6241 同类，BUG-D 已修复）：列表排序必须是确定性全序。
 *
 * Postgres 对 ORDER BY 非唯一键的并列行顺序未定义（受物理布局/并发更新影响），
 * LIMIT/OFFSET 翻页可重复/漏行。修复方式是结构性的：resolveOrderBy 的
 * tiebreaker 从「可选」改为「必选」编译期参数——不传唯一列无法通过类型检查，
 * 「无全序的排序」在调用点不可表达。本测锁定输出不变量：
 * 排序恒为两段（主排序键 + 唯一 tiebreaker 的 desc）。
 */

const t = pgTable('lq_total_order', {
  id: integer('id'),
  sortOrder: integer('sort_order'),
  createdAt: timestamp('created_at'),
});

describe('resolveOrderBy 全序不变量（#6241 同类回归锁）', () => {
  it('任意白名单排序：输出恒为主键 + tiebreaker 两段', () => {
    const orderBy = resolveOrderBy(
      { sort_by: 'sortOrder', order: 'asc' } as never,
      { sortOrder: t.sortOrder!, createdAt: t.createdAt! },
      'sortOrder',
      t.id!,
    );
    expect(orderBy).toHaveLength(2);
  });

  it('fallback 排序同样两段', () => {
    const orderBy = resolveOrderBy(
      {} as never,
      { sortOrder: t.sortOrder!, createdAt: t.createdAt! },
      'createdAt',
      t.id!,
    );
    expect(orderBy).toHaveLength(2);
  });
});
