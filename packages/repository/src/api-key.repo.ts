/**
 * API Key 仓储（client-api Key 管理聚合）：创建/列表/吊销。
 * 鉴权路径的读（findActiveKeyByKeyHash）在 CredentialRepository——凭证消费与凭证管理分居。
 * 吊销是 CAS（status=0→1）单语句：并发重复吊销只有一方成功，语义化翻译在上层。
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { apiKeys, users } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

/** Key 行形状（列表/详情投影——永不包含 keyHash） */
export interface ApiKeyRow {
  id: number;
  keyPreview: string;
  name: string;
  remark: string | null;
  status: number;
  subscriptionId: number | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  dailySpendLimit: string | null;
  allowPaygFallback: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface InsertApiKeyInput {
  keyHash: string;
  keyPreview: string;
  userId: number;
  name: string;
  remark?: string | null;
  subscriptionId?: number | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailySpendLimit?: string | null;
  allowPaygFallback?: boolean;
  expiresAt?: Date | null;
}

/** API Key 仓储（无状态；方法统一接收 RepoContext） */
export class ApiKeyRepository {
  async insertKey(c: RepoContext, input: InsertApiKeyInput): Promise<ApiKeyRow> {
    const [row] = await tx(c)
      .insert(apiKeys)
      .values({
        keyHash: input.keyHash,
        keyPreview: input.keyPreview,
        userId: input.userId,
        name: input.name,
        remark: input.remark ?? null,
        subscriptionId: input.subscriptionId ?? null,
        rpmLimit: input.rpmLimit ?? null,
        tpmLimit: input.tpmLimit ?? null,
        dailySpendLimit: input.dailySpendLimit ?? null,
        allowPaygFallback: input.allowPaygFallback ?? false,
        expiresAt: input.expiresAt ?? null,
      })
      .returning({
        id: apiKeys.id,
        keyPreview: apiKeys.keyPreview,
        name: apiKeys.name,
        remark: apiKeys.remark,
        status: apiKeys.status,
        subscriptionId: apiKeys.subscriptionId,
        rpmLimit: apiKeys.rpmLimit,
        tpmLimit: apiKeys.tpmLimit,
        dailySpendLimit: apiKeys.dailySpendLimit,
        allowPaygFallback: apiKeys.allowPaygFallback,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      });
    return row!;
  }

  /** 属主列表（id 倒序；不返回 keyHash——哈希只服务鉴权查表） */
  async listByUser(
    c: RepoContext,
    input: { userId: number; limit: number; offset: number },
  ): Promise<{ rows: ApiKeyRow[]; total: number }> {
    const rows = await c.db
      .select({
        id: apiKeys.id,
        keyPreview: apiKeys.keyPreview,
        name: apiKeys.name,
        remark: apiKeys.remark,
        status: apiKeys.status,
        subscriptionId: apiKeys.subscriptionId,
        rpmLimit: apiKeys.rpmLimit,
        tpmLimit: apiKeys.tpmLimit,
        dailySpendLimit: apiKeys.dailySpendLimit,
        allowPaygFallback: apiKeys.allowPaygFallback,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, input.userId))
      .orderBy(desc(apiKeys.id))
      .limit(input.limit)
      .offset(input.offset);
    const [countRow] = await c.db
      .select({ n: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(eq(apiKeys.userId, input.userId));
    return { rows, total: countRow?.n ?? 0 };
  }

  /** 在用 Key 数量（配额闸读模型） */
  async countActiveByUser(c: RepoContext, userId: number): Promise<number> {
    const [row] = await c.db
      .select({ n: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.status, 0)));
    return row?.n ?? 0;
  }

  /** 属主单查（越权访问在 repo 边界即无行——不泄漏他人 Key 的存在性） */
  async findOwned(
    c: RepoContext,
    input: { userId: number; keyId: number },
  ): Promise<ApiKeyRow | null> {
    const [row] = await c.db
      .select({
        id: apiKeys.id,
        keyPreview: apiKeys.keyPreview,
        name: apiKeys.name,
        remark: apiKeys.remark,
        status: apiKeys.status,
        subscriptionId: apiKeys.subscriptionId,
        rpmLimit: apiKeys.rpmLimit,
        tpmLimit: apiKeys.tpmLimit,
        dailySpendLimit: apiKeys.dailySpendLimit,
        allowPaygFallback: apiKeys.allowPaygFallback,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.userId, input.userId)));
    return row ?? null;
  }

  /** 吊销（CAS status=0→1）：已吊销/不存在/越权统一返回 null，上层翻 404/409 */
  async revokeKey(
    c: RepoContext,
    input: { userId: number; keyId: number; now: Date },
  ): Promise<{ id: number } | null> {
    const rows = await tx(c)
      .update(apiKeys)
      .set({ status: 1, revokedAt: input.now })
      .where(
        and(
          eq(apiKeys.id, input.keyId),
          eq(apiKeys.userId, input.userId),
          eq(apiKeys.status, 0),
        ),
      )
      .returning({ id: apiKeys.id });
    return rows[0] ?? null;
  }

  /**
   * 属主修改（CAS status=0）：改 name/remark/限额。v2 网关每请求查库无鉴权缓存，
   * 修改即时生效（v1 的「PATCH 后清缓存」问题结构性不存在）。
   */
  async patchKey(
    c: RepoContext,
    input: {
      userId: number;
      keyId: number;
      patch: {
        name?: string;
        remark?: string | null;
        rpmLimit?: number | null;
        tpmLimit?: number | null;
        dailySpendLimit?: string | null;
        expiresAt?: Date | null;
      };
    },
  ): Promise<ApiKeyRow | null> {
    const rows = await tx(c)
      .update(apiKeys)
      .set(input.patch)
      .where(
        and(
          eq(apiKeys.id, input.keyId),
          eq(apiKeys.userId, input.userId),
          eq(apiKeys.status, 0),
        ),
      )
      .returning({
        id: apiKeys.id,
        keyPreview: apiKeys.keyPreview,
        name: apiKeys.name,
        remark: apiKeys.remark,
        status: apiKeys.status,
        subscriptionId: apiKeys.subscriptionId,
        rpmLimit: apiKeys.rpmLimit,
        tpmLimit: apiKeys.tpmLimit,
        dailySpendLimit: apiKeys.dailySpendLimit,
        allowPaygFallback: apiKeys.allowPaygFallback,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      });
    return rows[0] ?? null;
  }

  // ── 管理面 ──────────────────────────────────────────────────────────────────

  /** 管理列表：q 命中 Key 名/预览/用户邮箱/用户名（join users——计数同 join 防 42P01） */
  async listAdminKeys(
    c: RepoContext,
    input: {
      q?: string;
      userId?: number;
      status?: number;
      sortBy: 'id' | 'name' | 'status' | 'lastUsedAt' | 'createdAt';
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    },
  ): Promise<{ rows: Array<Omit<ApiKeyRow, never> & { userId: number; userEmail: string | null; userDisplayName: string | null }>; total: number }> {
    const conditions = [];
    if (input.q) {
      const pattern = escapeLikePattern(input.q);
      conditions.push(
        or(
          ilike(apiKeys.name, pattern),
          ilike(apiKeys.keyPreview, pattern),
          ilike(users.email, pattern),
          ilike(users.displayName, pattern),
        )!,
      );
    }
    if (input.userId !== undefined) conditions.push(eq(apiKeys.userId, input.userId));
    if (input.status !== undefined) conditions.push(eq(apiKeys.status, input.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const sorts = {
      id: apiKeys.id,
      name: apiKeys.name,
      status: apiKeys.status,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(apiKeys.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: apiKeys.id,
          keyPreview: apiKeys.keyPreview,
          name: apiKeys.name,
          remark: apiKeys.remark,
          status: apiKeys.status,
          subscriptionId: apiKeys.subscriptionId,
          userId: apiKeys.userId,
          userEmail: users.email,
          userDisplayName: users.displayName,
          rpmLimit: apiKeys.rpmLimit,
          tpmLimit: apiKeys.tpmLimit,
          dailySpendLimit: apiKeys.dailySpendLimit,
          allowPaygFallback: apiKeys.allowPaygFallback,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.userId, users.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.userId, users.id))
        .where(where),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }

  /**
   * 管理补丁（不限属主；status 枚举由路由 zod 收口 0..1）。
   * 返回 keyHash 供调用方清网关鉴权缓存——预览列永不外发。
   */
  async adminPatchKey(
    c: RepoContext,
    input: {
      keyId: number;
      patch: {
        name?: string;
        rpmLimit?: number | null;
        tpmLimit?: number | null;
        dailySpendLimit?: string | null;
        status?: number;
      };
    },
  ): Promise<{ id: number; keyHash: string } | null> {
    const rows = await c.db
      .update(apiKeys)
      .set(input.patch)
      .where(eq(apiKeys.id, input.keyId))
      .returning({ id: apiKeys.id, keyHash: apiKeys.keyHash });
    return rows[0] ?? null;
  }

}
