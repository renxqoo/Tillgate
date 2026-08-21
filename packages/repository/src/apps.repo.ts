/**
 * Apps 仓储（企业 Agent 凭证管理）：client_secret 只存 SHA-256（明文仅创建/轮换时
 * 下发一次）；禁用/轮换都是属主限定 CAS。鉴权路径（/oauth/token 的 apps 查表）在
 * CredentialRepository——凭证消费与凭证管理分居。
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { apps } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

export interface AppRow {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  description: string | null;
  subscriptionId: number | null;
  scope: { models?: string[]; rpm?: number; tpm?: number } | null;
  status: number;
  rotatedAt: Date | null;
  createdAt: Date;
}

/** Apps 仓储（无状态；方法统一接收 RepoContext） */
export class AppsRepository {
  private readonly projection = {
    id: apps.id,
    appId: apps.appId,
    clientId: apps.clientId,
    name: apps.name,
    description: apps.description,
    subscriptionId: apps.subscriptionId,
    scope: apps.scope,
    status: apps.status,
    rotatedAt: apps.rotatedAt,
    createdAt: apps.createdAt,
  };

  async insertApp(
    c: RepoContext,
    input: {
      appId: string;
      userId: number;
      clientId: string;
      clientSecretHash: string;
      name: string;
      description?: string | null;
      subscriptionId?: number | null;
      scope?: { models?: string[]; rpm?: number; tpm?: number } | null;
    },
  ): Promise<AppRow> {
    const [row] = await tx(c)
      .insert(apps)
      .values({
        appId: input.appId,
        userId: input.userId,
        clientId: input.clientId,
        clientSecretHash: input.clientSecretHash,
        name: input.name,
        description: input.description ?? null,
        subscriptionId: input.subscriptionId ?? null,
        scope: input.scope ?? null,
      })
      .returning(this.projection);
    return row!;
  }

  async listByUser(
    c: RepoContext,
    input: { userId: number; limit: number; offset: number },
  ): Promise<{ rows: AppRow[]; total: number }> {
    const rows = await c.db
      .select(this.projection)
      .from(apps)
      .where(eq(apps.userId, input.userId))
      .orderBy(desc(apps.id))
      .limit(input.limit)
      .offset(input.offset);
    const [countRow] = await c.db
      .select({ n: sql<number>`count(*)::int` })
      .from(apps)
      .where(eq(apps.userId, input.userId));
    return { rows, total: countRow?.n ?? 0 };
  }

  /** 属主单查（越权在 repo 边界即无行） */
  async findOwned(
    c: RepoContext,
    input: { userId: number; appId: number },
  ): Promise<AppRow | null> {
    const [row] = await c.db
      .select(this.projection)
      .from(apps)
      .where(and(eq(apps.id, input.appId), eq(apps.userId, input.userId)));
    return row ?? null;
  }

  /** 禁用（CAS 0→1） */
  async disableApp(
    c: RepoContext,
    input: { userId: number; appId: number },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(apps)
      .set({ status: 1 })
      .where(and(eq(apps.id, input.appId), eq(apps.userId, input.userId), eq(apps.status, 0)))
      .returning({ id: apps.id });
    return rows.length > 0;
  }

  /** 轮换密钥（属主限定；明文由 service 生成仅此一次返回） */
  async rotateSecret(
    c: RepoContext,
    input: { userId: number; appId: number; clientSecretHash: string; rotatedAt: Date },
  ): Promise<boolean> {
    // FOR UPDATE 行锁：防并发轮换两个都"成功"、其中一个 secret 被静默孤儿化
    const locked = await tx(c)
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.id, input.appId), eq(apps.userId, input.userId)))
      .for('update')
      .limit(1);
    if (locked.length === 0) return false;
    const rows = await tx(c)
      .update(apps)
      .set({ clientSecretHash: input.clientSecretHash, rotatedAt: input.rotatedAt })
      .where(and(eq(apps.id, input.appId), eq(apps.userId, input.userId)))
      .returning({ id: apps.id });
    return rows.length > 0;
  }

  /** 在用 App 数（配额闸） */
  async countActiveByUser(
    c: RepoContext,
    userId: number,
  ): Promise<number> {
    const [row] = await c.db
      .select({ count: sql<number>`count(*)::int` })
      .from(apps)
      .where(and(eq(apps.userId, userId), eq(apps.status, 0)));
    return row?.count ?? 0;
  }

  /** App 配额串行化（与 Key 配额同口径：advisory xact lock 防 count→insert 竞态） */
  async advisoryLockAppQuota(c: RepoContext, userId: number): Promise<void> {
    await c.db.execute(sql`select pg_advisory_xact_lock(hashtext('apps-quota'), ${userId})`);
  }
}
