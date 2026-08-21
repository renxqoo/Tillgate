/**
 * rate_cards 费率卡仓储（管理面 CRUD + 卡内用户列表）。
 *
 * 不变量（服务层在事务内调用保证）：
 *   - 每张卡恰有一行 scope='global' 兜底系数（建卡同拍写入）
 *   - PATCH coefficient 只触碰 scope='global' 行——scope=model/group 的覆写行
 *     永不被全局更新抹平（M1：静默价格漂移事故的回归点）
 *   - 删除前置：无用户绑定（users.rateCardId 引用检查在服务层）
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { rateCardCoefficients, rateCards, users } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

export interface RateCardRow {
  id: number;
  name: string;
  description: string | null;
  status: number;
  createdAt: Date;
}

export interface RateCardListInput {
  q?: string;
  sortBy: 'id' | 'name' | 'status' | 'createdAt';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface RateCardUserRow {
  id: number;
  subject: string;
  email: string | null;
  displayName: string | null;
  createdAt: Date;
}

const CARD_COLUMNS = {
  id: rateCards.id,
  name: rateCards.name,
  description: rateCards.description,
  status: rateCards.status,
  createdAt: rateCards.createdAt,
};

const CARD_SORTS = {
  id: rateCards.id,
  name: rateCards.name,
  status: rateCards.status,
  createdAt: rateCards.createdAt,
} as const;

const CARD_USER_SORTS = {
  id: users.id,
  subject: users.subject,
  createdAt: users.createdAt,
} as const;

/** 费率卡仓储（无状态；写方法要求 RepoContext.db 为事务句柄——由服务层注入） */
export class RateCardRepository {
  /** 建卡 + 全局兜底系数（一个事务内的两写；返回新卡） */
  async insertWithGlobal(
    c: RepoContext,
    input: { name: string; description: string | null; coefficient: string },
  ): Promise<RateCardRow> {
    const [card] = await c.db
      .insert(rateCards)
      .values({ name: input.name, description: input.description, status: 0 })
      .returning(CARD_COLUMNS);
    if (!card) throw new Error('rate_card.insert_failed');
    await c.db.insert(rateCardCoefficients).values({
      rateCardId: card.id,
      scope: 'global',
      coefficient: input.coefficient,
    });
    return card as RateCardRow;
  }

  async findById(c: RepoContext, rateCardId: number): Promise<RateCardRow | null> {
    const [row] = await c.db.select(CARD_COLUMNS).from(rateCards).where(eq(rateCards.id, rateCardId));
    return (row as RateCardRow) ?? null;
  }

  /**
   * 更新卡面 + 全局系数（一个事务）：coefficient 非 undefined 时只更新
   * `scope='global'` 行——model/group 覆写行隔离（M1 回归点）。0 行 = 卡不存在。
   */
  async updateWithGlobal(
    c: RepoContext,
    input: {
      rateCardId: number;
      patch: { name?: string; description?: string | null; status?: number };
      globalCoefficient?: string;
    },
  ): Promise<{ id: number; name: string } | null> {
    const rows = await c.db
      .update(rateCards)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(eq(rateCards.id, input.rateCardId))
      .returning({ id: rateCards.id, name: rateCards.name });
    const card = rows[0];
    if (!card) return null;
    if (input.globalCoefficient !== undefined) {
      await c.db
        .update(rateCardCoefficients)
        .set({ coefficient: input.globalCoefficient })
        .where(
          and(eq(rateCardCoefficients.rateCardId, input.rateCardId), eq(rateCardCoefficients.scope, 'global')),
        );
    }
    return card;
  }

  async countBoundUsers(c: RepoContext, rateCardId: number): Promise<number> {
    const [row] = await c.db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.rateCardId, rateCardId));
    return row?.count ?? 0;
  }

  /** 硬删（系数行先于卡行——FK NO ACTION；存在性由卡行返回值表达） */
  async deleteCard(c: RepoContext, input: { rateCardId: number }): Promise<boolean> {
    await c.db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, input.rateCardId));
    const rows = await c.db.delete(rateCards).where(eq(rateCards.id, input.rateCardId)).returning({ id: rateCards.id });
    return rows.length > 0;
  }

  /** 卡列表 + 各卡全局系数（缺行 = null，服务层按 '1.000' 兜底回显） */
  async list(
    c: RepoContext,
    input: RateCardListInput,
  ): Promise<{ rows: Array<RateCardRow & { globalCoefficient: string | null }>; total: number }> {
    const where = input.q ? ilike(rateCards.name, escapeLikePattern(input.q)) : undefined;
    const column = CARD_SORTS[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(rateCards.id)];
    const [cards, countRows] = await Promise.all([
      c.db.select(CARD_COLUMNS).from(rateCards).where(where).orderBy(...orderBy).limit(input.limit).offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(rateCards).where(where),
    ]);
    const coefficients = cards.length
      ? await c.db
          .select({ rateCardId: rateCardCoefficients.rateCardId, coefficient: rateCardCoefficients.coefficient })
          .from(rateCardCoefficients)
          .where(
            and(
              eq(rateCardCoefficients.scope, 'global'),
              inArray(
                rateCardCoefficients.rateCardId,
                cards.map((card) => card.id),
              ),
            ),
          )
      : [];
    const byCard = new Map(coefficients.map((row) => [row.rateCardId, row.coefficient]));
    return {
      rows: cards.map((card) => ({ ...(card as RateCardRow), globalCoefficient: byCard.get(card.id) ?? null })),
      total: countRows[0]?.count ?? 0,
    };
  }

  /** 绑定该卡的用户（q 命中 subject/email/displayName） */
  async listCardUsers(
    c: RepoContext,
    input: { rateCardId: number; q?: string; sortBy: 'id' | 'subject' | 'createdAt'; order: 'asc' | 'desc'; limit: number; offset: number },
  ): Promise<{ rows: RateCardUserRow[]; total: number }> {
    const conditions = [eq(users.rateCardId, input.rateCardId)];
    if (input.q) {
      const pattern = escapeLikePattern(input.q);
      conditions.push(
        or(ilike(users.subject, pattern), ilike(users.email, pattern), ilike(users.displayName, pattern))!,
      );
    }
    const where = and(...conditions);
    const column = CARD_USER_SORTS[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(users.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: users.id,
          subject: users.subject,
          email: users.email,
          displayName: users.displayName,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(users).where(where),
    ]);
    return { rows: rows as RateCardUserRow[], total: countRows[0]?.count ?? 0 };
  }

  /** 健康自检：全局兜底系数是否存在（约束「每卡恰一全局行」） */
  async findGlobalCoefficient(c: RepoContext, rateCardId: number): Promise<string | null> {
    const [row] = await c.db
      .select({ coefficient: rateCardCoefficients.coefficient })
      .from(rateCardCoefficients)
      .where(and(eq(rateCardCoefficients.rateCardId, rateCardId), eq(rateCardCoefficients.scope, 'global')));
    return row?.coefficient ?? null;
  }

  // ── 管理面 ──────────────────────────────────────────────────────────────────

  /** 按名精确查（默认卡「标准」解析用） */
  async findByName(c: RepoContext, name: string): Promise<RateCardRow | null> {
    const [row] = await c.db.select(CARD_COLUMNS).from(rateCards).where(eq(rateCards.name, name));
    return (row as RateCardRow) ?? null;
  }

  /**
   * 全局兜底系数回填：缺行则补 1.000（onConflictDoNothing——并发管理员双写安全）。
   * 数据模型 §3.9「每卡恰一全局行」的应用侧兜底。
   */
  async ensureGlobalCoefficient(c: RepoContext, rateCardId: number): Promise<void> {
    await c.db
      .insert(rateCardCoefficients)
      .values({ rateCardId, scope: 'global', coefficient: '1.000' })
      .onConflictDoNothing();
  }
}
