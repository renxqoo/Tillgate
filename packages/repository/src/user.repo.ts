/**
 * users 仓储：授权管线只读模型 + 管理面列表/补丁（账户域语义在 admin-api 服务层）。
 * 列白名单永不包含 passwordHash（改密走 userAccount.updatePassword 的哈希入口）。
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { apiKeys, auditLogs, rateCards, users } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

/** 管理面用户行（列白名单——永不包含 passwordHash） */
export interface AdminUserRow {
  id: number;
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  rateCardName: string | null;
  dailySpendLimit: string | null;
  status: number;
  freezeReason: string | null;
  isEnterprise: boolean;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** 管理面用户补丁（白名单字段；freezeReason 仅随封禁一并落——服务层校验） */
export interface AdminUserPatch {
  status?: number;
  rateCardId?: number | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailySpendLimit?: string | null;
  displayName?: string | null;
  email?: string | null;
  isEnterprise?: boolean;
  freezeReason?: string | null;
}

export interface AdminUserListInput {
  q?: string;
  status?: number;
  /** '1' 只看企业 / '0' 只看个人（缺省 = 不过滤） */
  enterprise?: '0' | '1';
  sortBy: 'id' | 'subject' | 'createdAt' | 'lastLoginAt';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** users 仓储（无状态；方法统一接收 RepoContext） */
export class UserRepository {
  async userExists(c: RepoContext, userId: number): Promise<boolean> {
    const [row] = await c.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    return row != null;
  }

  async isEnterprise(c: RepoContext, userId: number): Promise<boolean> {
    const [row] = await c.db
      .select({ isEnterprise: users.isEnterprise })
      .from(users)
      .where(eq(users.id, userId));
    return row?.isEnterprise === true;
  }

  /** 用户绑定的费率卡 id（报价系数解析入口；null=无卡恒系数 1） */
  async findRateCardId(c: RepoContext, userId: number): Promise<number | null> {
    const [row] = await c.db
      .select({ rateCardId: users.rateCardId })
      .from(users)
      .where(eq(users.id, userId));
    return row?.rateCardId ?? null;
  }

  /** 用户级每日花费上限（授权管线限额闸读模型） */
  async findDailySpendLimit(c: RepoContext, userId: number): Promise<string | null> {
    const [row] = await c.db
      .select({ dailySpendLimit: users.dailySpendLimit })
      .from(users)
      .where(eq(users.id, userId));
    return row?.dailySpendLimit ?? null;
  }

  // ── 管理面 ──────────────────────────────────────────────────────────────────

  /** 单查（含 issuer/rateCardId；不含 passwordHash） */
  async findAdminUser(
    c: RepoContext,
    userId: number,
  ): Promise<Omit<AdminUserRow, 'rateCardName'> | null> {
    const [row] = await c.db
      .select({
        id: users.id,
        issuer: users.issuer,
        subject: users.subject,
        email: users.email,
        displayName: users.displayName,
        rateCardId: users.rateCardId,
        dailySpendLimit: users.dailySpendLimit,
        status: users.status,
        freezeReason: users.freezeReason,
        isEnterprise: users.isEnterprise,
        rpmLimit: users.rpmLimit,
        tpmLimit: users.tpmLimit,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    return row ?? null;
  }

  /** 用户面 profile 单查（含费率卡名——v1 /api/me 对位） */
  async findProfile(
    c: RepoContext,
    userId: number,
  ): Promise<Omit<AdminUserRow, 'id'> | null> {
    const [row] = await c.db
      .select({
        issuer: users.issuer,
        subject: users.subject,
        email: users.email,
        displayName: users.displayName,
        rateCardId: users.rateCardId,
        rateCardName: rateCards.name,
        dailySpendLimit: users.dailySpendLimit,
        status: users.status,
        freezeReason: users.freezeReason,
        isEnterprise: users.isEnterprise,
        rpmLimit: users.rpmLimit,
        tpmLimit: users.tpmLimit,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(rateCards, eq(rateCards.id, users.rateCardId))
      .where(eq(users.id, userId));
    return row ?? null;
  }

  /** 统一列表：q 命中 subject/email/displayName；leftJoin rateCards 带卡名 */
  async listAdminUsers(
    c: RepoContext,
    input: AdminUserListInput,
  ): Promise<{ rows: AdminUserRow[]; total: number }> {
    const conditions = [];
    if (input.q) {
      const pattern = escapeLikePattern(input.q);
      conditions.push(
        or(ilike(users.subject, pattern), ilike(users.email, pattern), ilike(users.displayName, pattern))!,
      );
    }
    if (input.status !== undefined) conditions.push(eq(users.status, input.status));
    if (input.enterprise !== undefined) {
      conditions.push(eq(users.isEnterprise, input.enterprise === '1'));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const sorts = {
      id: users.id,
      subject: users.subject,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(users.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: users.id,
          issuer: users.issuer,
          subject: users.subject,
          email: users.email,
          displayName: users.displayName,
          rateCardId: users.rateCardId,
          rateCardName: rateCards.name,
          dailySpendLimit: users.dailySpendLimit,
          status: users.status,
          freezeReason: users.freezeReason,
          isEnterprise: users.isEnterprise,
          rpmLimit: users.rpmLimit,
          tpmLimit: users.tpmLimit,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
        .where(where),
    ]);
    return { rows: rows as AdminUserRow[], total: countRows[0]?.count ?? 0 };
  }

  /** 部分更新（白名单）；0 行 = 用户不存在 */
  async patchUser(c: RepoContext, input: { userId: number; patch: AdminUserPatch }): Promise<boolean> {
    const rows = await c.db
      .update(users)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(eq(users.id, input.userId))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /** 用户全部 Key 哈希（状态/限额变更后清网关鉴权缓存用） */
  async listKeyHashesByUser(c: RepoContext, userId: number): Promise<string[]> {
    const rows = await c.db
      .select({ keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId));
    return rows.map((r) => r.keyHash);
  }

  /** 用户维度审计日志（q 命中 action/targetId） */
  async listAuditLogsForUser(
    c: RepoContext,
    input: {
      userId: number;
      q?: string;
      sortBy: 'id' | 'action' | 'createdAt';
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    },
  ): Promise<{
    rows: Array<{ id: number; actor: string; action: string; detail: unknown; createdAt: Date }>;
    total: number;
  }> {
    const conditions = [eq(auditLogs.targetType, 'user'), eq(auditLogs.targetId, String(input.userId))];
    if (input.q) {
      const pattern = escapeLikePattern(input.q);
      conditions.push(or(ilike(auditLogs.action, pattern), ilike(auditLogs.targetId, pattern))!);
    }
    const where = and(...conditions);
    const sorts = { id: auditLogs.id, action: auditLogs.action, createdAt: auditLogs.createdAt } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(auditLogs.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: auditLogs.id,
          actor: auditLogs.actor,
          action: auditLogs.action,
          detail: auditLogs.detail,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(where),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }

  /** 按 subject 批量取 id（测试/对账便利） */
  async findIdsBySubjects(c: RepoContext, subjects: readonly string[]): Promise<number[]> {
    if (subjects.length === 0) return [];
    const rows = await c.db.select({ id: users.id }).from(users).where(inArray(users.subject, [...subjects]));
    return rows.map((r) => r.id);
  }
}
