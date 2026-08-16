import { eq, and, sql, gte, lte } from 'drizzle-orm';
import { users, rateCards, rateCardCoefficients, apiKeys, transactions, auditLogs } from '@ai-gateway/db/schema';
import { hashPassword } from '@ai-gateway/identity';
import { LedgerError, LEDGER_HTTP } from '@ai-gateway/ledger';
import { HttpError, invalidateKeyAuthCache, recordAudit, buildList, countAll, listQuerySchema, paginateQuery, type KnownErrorCode } from '@ai-gateway/http';
import { z } from 'zod';
import type { AdminServices } from './index.js';

/**
 * 用户管理服务：列表/详情/更新/改密共用的列集合与写操作规则。
 *
 * 安全：userProfileColumns 是显式列白名单（不含 passwordHash），
 *       所有返回用户数据的查询必须走它——防止 .returning() 无参整行泄露凭据。
 *       注意：userProfileColumns 含联表列（rateCards.name），只能用于 SELECT；
 *       update 的 returning 用 userColumns（仅 users 表自身列）。
 */
export const userColumns = {
  id: users.id,
  issuer: users.issuer,
  subject: users.subject,
  identityProvider: users.identityProvider,
  email: users.email,
  displayName: users.displayName,
  rateCardId: users.rateCardId,
  balance: users.balance,
  reservedBalance: users.reservedBalance,
  creditLimit: users.creditLimit,
  dailySpendLimit: users.dailySpendLimit,
  status: users.status,
  isEnterprise: users.isEnterprise,
  freezeReason: users.freezeReason,
  rpmLimit: users.rpmLimit,
  tpmLimit: users.tpmLimit,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

/** 列表/详情展示列：userColumns + 费率卡名（联表）。
 *  availableBalance = 可用余额口径：普通 Key 扣费 + 购买套餐/加油包都用余额，
 *  判定是 balance - reserved，不含 creditLimit（透支额度不构成购买力/可用余额展示）。 */
export const userProfileColumns = {
  ...userColumns,
  availableBalance: sql<string>`${users.balance} - ${users.reservedBalance}`,
  rateCardName: rateCards.name,
};

export type UserPatch = {
  /** 0 正常 / 1 封禁 / 2 注销 */
  status?: number;
  rateCardId?: number | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  /** 透支上限（元，>=0）。信用模型：balance 允许降到 -credit_limit。 */
  creditLimit?: number;
  /** 每日花费上限（元，>=0）。NULL=不限。防羊毛党细水长流。 */
  dailySpendLimit?: number | null;
  displayName?: string;
  email?: string | null;
  freezeReason?: string | null;
  /** 是否企业用户（企业用户可购买团队套餐/席位） */
  isEnterprise?: boolean;
};

/** 用户不存在（供调整错误分支复用） */
export const USER_NOT_FOUND = new HttpError('USER_NOT_FOUND', '用户不存在');

/**
 * ledger 业务错误 → HTTP（映射表单一真相：packages/ledger error-catalog）。
 */
export function mapLedgerError(error: unknown): HttpError {
  if (error instanceof LedgerError) {
    const m = LEDGER_HTTP[error.code];
    return new HttpError(m.code as KnownErrorCode, error.message || m.message);
  }
  throw error;
}

/**
 * 更新用户（封禁/解封/绑卡/限流/资料）。
 * 规则：
 *   - 绑卡前校验费率卡存在且启用
 *   - 封禁记录 freezeReason，解封清空
 *   - 状态/限流变更时清 gateway Key 鉴权缓存（封禁立即生效，不等 60s TTL）
 */
export async function updateUser(
  s: AdminServices,
  id: number,
  patch: UserPatch,
  adminId: number,
): Promise<Record<string, unknown>> {
  if (patch.rateCardId !== undefined && patch.rateCardId !== null) {
    const card = await s.db
      .select({ id: rateCards.id, status: rateCards.status })
      .from(rateCards)
      .where(eq(rateCards.id, patch.rateCardId))
      .limit(1);
    if (card.length === 0) throw new HttpError('RATE_CARD_NOT_FOUND', '费率卡不存在');
    if (card[0]!.status !== 0)
      throw new HttpError('RATE_CARD_DISABLED', '费率卡已停用，无法绑定');
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.rateCardId !== undefined) update.rateCardId = patch.rateCardId;
  if (patch.rpmLimit !== undefined) update.rpmLimit = patch.rpmLimit;
  if (patch.tpmLimit !== undefined) update.tpmLimit = patch.tpmLimit;
  if (patch.creditLimit !== undefined) update.creditLimit = patch.creditLimit;
  if (patch.dailySpendLimit !== undefined) update.dailySpendLimit = patch.dailySpendLimit;
  if (patch.displayName !== undefined) update.displayName = patch.displayName;
  if (patch.email !== undefined) {
    update.email = patch.email;
    // email 是 org 邀请匹配键且关联登录身份——变更视同敏感操作，吊销既有会话
    update.sessionInvalidBefore = new Date();
  }
  if (patch.isEnterprise !== undefined) update.isEnterprise = patch.isEnterprise;
  // 封禁时记原因；解封清空原因
  if (patch.status === 1) update.freezeReason = patch.freezeReason ?? '管理员封禁';
  if (patch.status === 0) update.freezeReason = null;

  const [updated] = await s.db
    .update(users)
    .set(update)
    .where(eq(users.id, id))
    .returning(userColumns);
  if (!updated) throw USER_NOT_FOUND;

  // 封禁/解封/限流变更 → 清 gateway auth cache（auth:key:{hash} TTL 60s，不主动清则延迟生效）
  if (patch.status !== undefined || patch.rpmLimit !== undefined || patch.tpmLimit !== undefined) {
    const keys = await s.db
      .select({ keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.userId, id));
    await invalidateKeyAuthCache(
      s.redis,
      keys.map((k) => k.keyHash),
    );
  }

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'user.update',
    targetType: 'user',
    targetId: id,
    detail: patch,
  });
  return updated;
}

/**
 * 管理员开通本地账号：设置初始密码 + 绑定默认「标准」费率卡。
 * 若目标卡缺 global 系数行（历史数据），由 ensureGlobalCoefficient 补齐。
 */
export async function setUserPassword(
  s: AdminServices,
  id: number,
  password: string,
  adminId: number,
): Promise<void> {
  const cur = await s.db
    .select({ rateCardId: users.rateCardId, issuer: users.issuer })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (cur.length === 0) throw USER_NOT_FOUND;
  // 本地密码只对本地账号有意义；给外部 OIDC 身份挂本地密码等于管理员接管该身份
  if (cur[0]!.issuer !== 'local') {
    throw new HttpError('NOT_LOCAL_ACCOUNT', '只能为本地账号（issuer=local）设置密码');
  }

  const hash = await hashPassword(password);
  // R5-2：重置密码即吊销该用户全部既有会话
  const update: Record<string, unknown> = { passwordHash: hash, sessionInvalidBefore: new Date(), updatedAt: new Date() };
  if (cur[0]!.rateCardId === null) {
    const card = await s.db
      .select({ id: rateCards.id })
      .from(rateCards)
      .where(eq(rateCards.name, '标准'))
      .limit(1);
    if (card.length > 0) {
      update.rateCardId = card[0]!.id;
      await ensureGlobalCoefficient(s, card[0]!.id);
    }
  }
  await s.db.update(users).set(update).where(eq(users.id, id));

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'user.set_password',
    targetType: 'user',
    targetId: id,
  });
}

/** 确保费率卡存在 global 系数行（data-model §3.9：每卡必有且仅有一行 global 兜底系数） */
export async function ensureGlobalCoefficient(s: AdminServices, rateCardId: number): Promise<void> {
  const coeff = await s.db
    .select({ id: rateCardCoefficients.id })
    .from(rateCardCoefficients)
    .where(
      and(
        eq(rateCardCoefficients.rateCardId, rateCardId),
        eq(rateCardCoefficients.scope, 'global'),
      ),
    )
    .limit(1);
  if (coeff.length === 0) {
    // onConflictDoNothing：并发补齐（如两个管理员同时 set-password）不炸唯一键
    await s.db
      .insert(rateCardCoefficients)
      .values({ rateCardId, scope: 'global', coefficient: '1.000' })
      .onConflictDoNothing();
  }
}

export const userListQuerySchema = listQuerySchema.extend({
  status: z.coerce.number().int().min(0).max(2).optional(),
  /** 企业/个人筛选：1=企业，0=个人 */
  enterprise: z.enum(['0', '1']).optional(),
});

export const userTransactionsQuerySchema = listQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function listUsers(s: AdminServices, q: z.infer<typeof userListQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(q, {
    search: [users.subject, users.email, users.displayName],
    conditions: [
      q.status !== undefined ? eq(users.status, q.status) : undefined,
      q.enterprise !== undefined ? eq(users.isEnterprise, q.enterprise === '1') : undefined,
    ],
    sort: {
      by: {
        id: users.id,
        subject: users.subject,
        balance: users.balance,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      },
      fallback: 'createdAt',
      tiebreaker: users.id,
    },
  });
  return paginateQuery(
    page,
    s.db
      .select(userProfileColumns)
      .from(users)
      .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, users, where),
  );
}

export async function getUserProfile(s: AdminServices, id: number) {
  const rows = await s.db
    .select(userProfileColumns)
    .from(users)
    .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
    .where(eq(users.id, id))
    .limit(1);
  if (rows.length === 0) throw USER_NOT_FOUND;
  return rows[0];
}

export async function listUserTransactions(s: AdminServices, id: number, q: z.infer<typeof userTransactionsQuerySchema>) {
  // from/to 时间范围（与用户面 /api/me/transactions 同语义）
  const { page, limit, offset, where, orderBy } = buildList(q, {
    search: [transactions.remark, transactions.refId, transactions.type],
    conditions: [
      eq(transactions.userId, id),
      q.from ? gte(transactions.createdAt, new Date(q.from)) : undefined,
      q.to ? lte(transactions.createdAt, new Date(q.to)) : undefined,
    ],
    sort: {
      by: { id: transactions.id, amount: transactions.amount, createdAt: transactions.createdAt },
      fallback: 'createdAt',
      tiebreaker: transactions.id,
    },
  });
  return paginateQuery(
    page,
    s.db.select().from(transactions).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    countAll(s.db, transactions, where),
  );
}

export async function listUserAuditLogs(s: AdminServices, id: number, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [auditLogs.action, auditLogs.targetId],
    conditions: [eq(auditLogs.targetType, 'user'), eq(auditLogs.targetId, String(id))],
    sort: {
      by: { id: auditLogs.id, action: auditLogs.action, createdAt: auditLogs.createdAt },
      fallback: 'createdAt',
      tiebreaker: auditLogs.id,
    },
  });
  return paginateQuery(
    page,
    s.db.select().from(auditLogs).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    countAll(s.db, auditLogs, where),
  );
}
