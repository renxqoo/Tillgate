/**
 * rate_cards 费率卡 postgres 适配器（v1 rate-card.repo 等价迁移）。
 * 不变量（application 在事务内调用保证）：每张卡恰有一行 scope='global' 兜底系数；
 * PATCH coefficient 只触碰 global 行——scope=model/group 覆写行永不被全局更新抹平（M1）。
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { rateCardCoefficients, rateCards, users } from '@tillgate/db';
import type {
  UserRateCardContext,
  RateCardStore,
  RateCardRecord,
  RateCardSortField,
  RateCardUserRow,
  RateCardUserSortField,
} from '../../ports/rate-card-store';
import { escapeLikePattern } from './search';

const CARD_COLUMNS = {
  id: rateCards.id,
  name: rateCards.name,
  description: rateCards.description,
  status: rateCards.status,
  createdAt: rateCards.createdAt,
  updatedAt: rateCards.updatedAt,
} as const;

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

export const postgresRateCardStore: RateCardStore = {
  async insertWithGlobal(db, input) {
    // 建卡 + 全局兜底系数（一个事务内的两写；application 持事务）
    const [card] = await db
      .insert(rateCards)
      .values({ name: input.name, description: input.description, status: 0 })
      .returning(CARD_COLUMNS);
    if (!card) throw new Error('rate_card.insert_failed');
    await db.insert(rateCardCoefficients).values({
      rateCardId: card.id,
      scope: 'global',
      coefficient: input.coefficient,
    });
    return card as RateCardRecord;
  },

  async findById(db, rateCardId) {
    const [row] = await db.select(CARD_COLUMNS).from(rateCards).where(eq(rateCards.id, rateCardId));
    return (row as RateCardRecord) ?? null;
  },

  async updateWithGlobal(db, input) {
    const rows = await db
      .update(rateCards)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(eq(rateCards.id, input.rateCardId))
      .returning({ id: rateCards.id, name: rateCards.name });
    const [card] = rows;
    if (!card) return null;
    if (input.globalCoefficient !== undefined) {
      // 只更新 scope='global' 行——model/group 覆写行隔离（M1 回归点）
      await db
        .update(rateCardCoefficients)
        .set({ coefficient: input.globalCoefficient })
        .where(
          and(
            eq(rateCardCoefficients.rateCardId, input.rateCardId),
            eq(rateCardCoefficients.scope, 'global'),
          ),
        );
    }
    return card;
  },

  async countBoundUsers(db, rateCardId) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.rateCardId, rateCardId));
    return row?.count ?? 0;
  },

  async deleteCard(db, input) {
    // 硬删（系数行先于卡行——FK NO ACTION；存在性由卡行返回值表达）
    await db
      .delete(rateCardCoefficients)
      .where(eq(rateCardCoefficients.rateCardId, input.rateCardId));
    const rows = await db
      .delete(rateCards)
      .where(eq(rateCards.id, input.rateCardId))
      .returning({ id: rateCards.id });
    return rows.length > 0;
  },

  async list(db, query) {
    const where = query.q ? ilike(rateCards.name, escapeLikePattern(query.q)) : undefined;
    const column = CARD_SORTS[query.sortBy as RateCardSortField];
    const orderBy = [query.order === 'asc' ? asc(column) : desc(column), desc(rateCards.id)];
    const [cards, countRows] = await Promise.all([
      db
        .select(CARD_COLUMNS)
        .from(rateCards)
        .where(where)
        .orderBy(...orderBy)
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(rateCards)
        .where(where),
    ]);
    const coefficients =
      cards.length > 0
        ? await db
            .select({
              rateCardId: rateCardCoefficients.rateCardId,
              coefficient: rateCardCoefficients.coefficient,
            })
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
      rows: cards.map((card) => ({
        ...(card as RateCardRecord),
        globalCoefficient: byCard.get(card.id) ?? null,
      })),
      total: countRows[0]?.count ?? 0,
    };
  },

  async listCardUsers(db, query) {
    const conditions = [eq(users.rateCardId, query.rateCardId)];
    if (query.q) {
      const pattern = escapeLikePattern(query.q);
      // drizzle or() 返回 SQL|undefined,三个非空入参下必为 SQL——显式收窄
      const cond = or(
        ilike(users.subject, pattern),
        ilike(users.email, pattern),
        ilike(users.displayName, pattern),
      );
      if (cond !== undefined) conditions.push(cond);
    }
    const where = and(...conditions);
    const column = CARD_USER_SORTS[query.sortBy as RateCardUserSortField];
    const orderBy = [query.order === 'asc' ? asc(column) : desc(column), desc(users.id)];
    const [rows, countRows] = await Promise.all([
      db
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
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(where),
    ]);
    return { rows: rows as RateCardUserRow[], total: countRows[0]?.count ?? 0 };
  },

  async findGlobalCoefficient(db, rateCardId) {
    const [row] = await db
      .select({ coefficient: rateCardCoefficients.coefficient })
      .from(rateCardCoefficients)
      .where(
        and(
          eq(rateCardCoefficients.rateCardId, rateCardId),
          eq(rateCardCoefficients.scope, 'global'),
        ),
      );
    return row?.coefficient ?? null;
  },

  // ---- 网关热路径读（G1；users.rate_card_id 读侧 join——绑定写侧归 accounts） ----

  async findActiveCardByUser(db, userId) {
    const [card] = await db
      .select({ cardId: rateCards.id, cardName: rateCards.name, status: rateCards.status })
      .from(users)
      .innerJoin(rateCards, eq(users.rateCardId, rateCards.id))
      .where(eq(users.id, userId));
    if (!card) return null;
    const coefficientRows = await db
      .select({
        scope: rateCardCoefficients.scope,
        modelMappingId: rateCardCoefficients.modelMappingId,
        groupKey: rateCardCoefficients.groupKey,
        coefficient: rateCardCoefficients.coefficient,
      })
      .from(rateCardCoefficients)
      .where(eq(rateCardCoefficients.rateCardId, card.cardId));
    return {
      cardId: card.cardId,
      cardName: card.cardName,
      status: card.status,
      coefficients: coefficientRows.map((row) => ({
        scope: row.scope as 'model' | 'group' | 'global',
        modelMappingId: row.modelMappingId,
        groupKey: row.groupKey,
        coefficient: row.coefficient,
      })),
    } satisfies UserRateCardContext;
  },
};
