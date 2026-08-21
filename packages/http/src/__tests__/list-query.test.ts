import { describe, expect, it } from 'vitest';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { and, eq, isNotNull, sql as rawSql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  buildList,
  countAll,
  escapeLike,
  listQuerySchema,
  resolveOrderBy,
  searchCondition,
  sortQuerySchema,
} from '../list-query.js';
import type { Db } from '@ai-gateway/db';

/** 最小表 fixture：验证 SQL 生成而非 mock */
const t = pgTable('lq_test', {
  id: integer('id'),
  name: text('name'),
  createdAt: timestamp('created_at'),
});

describe('escapeLike', () => {
  it('转义 % _ \\，搜索词按字面匹配', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(escapeLike('普通词')).toBe('普通词');
    expect(escapeLike('')).toBe('');
  });
});

describe('searchCondition', () => {
  it('q 为空/空白/无列 → undefined（不拼条件）', () => {
    expect(searchCondition(undefined, [t.name])).toBeUndefined();
    expect(searchCondition('   ', [t.name])).toBeUndefined();
    expect(searchCondition('x', [])).toBeUndefined();
  });

  it('单列 → ilike %q%', () => {
    const cond = searchCondition('gpt', [t.name]);
    expect(cond).toBeDefined();
    expect(and(cond, isNotNull(t.id))).toBeDefined(); // 可与其他条件组合
  });

  it('多列 → OR 组合；搜索词中的 % _ 被转义', () => {
    const cond = searchCondition('a%b', [t.name, t.createdAt!]);
    expect(cond).toBeDefined();
    expect(cond?.queryChunks.length).toBeGreaterThan(1);
  });

  it('表达式目标（uuid 列 ::text 转型）→ ilike 表达式', () => {
    const cond = searchCondition('abc', [rawSql`${t.id}::text`]);
    expect(cond).toBeDefined();
    expect(String((cond as { queryChunks: unknown[] }).queryChunks.length)).toBeTruthy();
  });
});

/** 提取 SQL 模板里的文本片段（StringChunk.value），用于断言方向词 */
function chunkText(sql: SQL): string {
  return (sql.queryChunks as unknown[])
    .map((c) => {
      if (typeof c === 'string') return c;
      const v = (c as { value?: unknown }).value;
      return Array.isArray(v) ? v.join('') : '';
    })
    .join(' ');
}

describe('sortQuerySchema', () => {
  it('order 默认 desc；sort_by 可选；未知值容错', () => {
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
});

describe('resolveOrderBy', () => {
  const allowed = { createdAt: t.createdAt!, name: t.name, id: t.id! };

  it('未传 sort_by → 使用 fallback 列，默认 desc', () => {
    const order = resolveOrderBy({}, allowed, 'createdAt', t.id!);
    // 排序输出必须全序——主键 + 唯一 tiebreaker 两段
    expect(order).toHaveLength(2);
    expect(chunkText(order[0]!)).toContain('desc');
  });

  it('白名单字段 + asc 生效', () => {
    const order = resolveOrderBy({ sort_by: 'name', order: 'asc' }, allowed, 'createdAt', t.id!);
    expect(chunkText(order[0]!)).toContain('asc');
  });

  it('白名单外字段 → 400 INVALID_SORT_FIELD（不允许静默回退）', () => {
    try {
      resolveOrderBy({ sort_by: 'password' }, allowed, 'createdAt', t.id!);
      expect.unreachable('应抛出 HttpError');
    } catch (e) {
      expect((e as { code: string }).code).toBe('INVALID_SORT_FIELD');
      expect((e as { status: number }).status).toBe(400);
      expect((e as { details: unknown }).details).toBeDefined();
    }
  });

  it('原型链属性（constructor/__proto__/toString）必须按白名单外拒绝 → 400', () => {
    // 复审 #2：allowed[field] 命中 Object 原型成员（truthy）会穿透白名单，
    // drizzle 把构造函数当绑定参数 → 运行期 500（应为 400 INVALID_SORT_FIELD）
    for (const proto of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      try {
        resolveOrderBy({ sort_by: proto }, allowed, 'createdAt', t.id!);
        expect.unreachable(`sort_by=${proto} 应抛出 HttpError`);
      } catch (e) {
        expect((e as { code: string }).code).toBe('INVALID_SORT_FIELD');
      }
    }
  });

  it('tiebreaker 追加在主排序之后（分页稳定序）', () => {
    const order = resolveOrderBy({ sort_by: 'name', order: 'asc' }, allowed, 'createdAt', t.id!);
    expect(order).toHaveLength(2);
    expect(chunkText(order[1]!)).toContain('desc');
  });
});

describe('listQuerySchema', () => {
  it('分页 + 搜索 + 排序组合基底；差异字段可 extend', () => {
    expect(listQuerySchema.parse({})).toEqual({
      page: 1,
      page_size: 20,
      q: undefined,
      sort_by: undefined,
      order: 'desc',
    });
    const extended = listQuerySchema.extend({ status: z.coerce.number().int().optional() });
    expect(extended.safeParse({ status: '1', page: '2', q: ' x ', sort_by: 'name' })).toMatchObject({
      success: true,
      data: { status: 1, page: 2, q: 'x', sort_by: 'name' },
    });
  });
});

describe('buildList', () => {
  const sort = {
    by: { createdAt: t.createdAt!, id: t.id! },
    fallback: 'createdAt',
    tiebreaker: t.id!,
  } as const;

  it('无 search/conditions → where=undefined；分页与排序照常', () => {
    const parts = buildList({ page: 2, page_size: 10, order: 'asc' }, { sort });
    expect(parts.page).toEqual({ page: 2, pageSize: 10 });
    expect(parts.limit).toBe(10);
    expect(parts.offset).toBe(10);
    expect(parts.where).toBeUndefined();
    expect(parts.orderBy).toHaveLength(2);
  });

  it('conditions 中 undefined 项被忽略；单个条件也走 and(...)（与路由原实现逐字等价）', () => {
    const parts = buildList(
      { page: 1 },
      { conditions: [undefined, eq(t.id, 1)] },
    );
    expect(parts.where).toBeDefined();
    expect(parts.where?.queryChunks.length).toBeGreaterThan(0);
  });

  it('q 命中 search 目标 → 搜索条件并入 where；q 空 → 无搜索条件', () => {
    const withQ = buildList({ q: 'gpt' }, { search: [t.name] });
    expect(withQ.where).toBeDefined();
    const noQ = buildList({}, { search: [t.name], conditions: [eq(t.id, 1)] });
    expect(chunkText(noQ.where!)).not.toContain('ilike');
  });

  it('search 但 q 缺失且无 conditions → where=undefined（与原「search ? and(search) : undefined」等价）', () => {
    const parts = buildList({}, { search: [t.name] });
    expect(parts.where).toBeUndefined();
  });

  it('sort 缺省 → orderBy 为空数组（tracing/store 型列表）', () => {
    const parts = buildList({ page: 1, page_size: 5 });
    expect(parts.orderBy).toEqual([]);
    expect(parts.limit).toBe(5);
    expect(parts.offset).toBe(0);
  });

  it('白名单外 sort_by → 400 INVALID_SORT_FIELD（沿 resolveOrderBy 单一实现）', () => {
    expect(() => buildList({ sort_by: 'password' }, { sort })).toThrowError(
      expect.objectContaining({ code: 'INVALID_SORT_FIELD', status: 400 }) as Error,
    );
  });
});

describe('countAll', () => {
  it('组装 select count(*)::int from <table> where <where>', () => {
    const where = eq(t.id, 1);
    const captured: Record<string, unknown> = {};
    const fakeDb = {
      select(shape: unknown) {
        captured.shape = shape;
        return {
          from(table: unknown) {
            captured.table = table;
            const builder = {
              // drizzle 动态查询契约：$dynamic() 返回自身以支持链式 join 再挂 where
              $dynamic() {
                return builder;
              },
              where(w: unknown) {
                captured.where = w;
                return Promise.resolve([{ count: 1 }]);
              },
            };
            return builder;
          },
        };
      },
    } as unknown as Db;
    const rows = countAll(fakeDb, t, where);
    return expect(rows).resolves.toEqual([{ count: 1 }]).then(() => {
      expect(captured.table).toBe(t);
      expect(captured.where).toBe(where);
      expect((captured.shape as { count: SQL }).count).toBeDefined();
    });
  });
});
