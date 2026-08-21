/**
 * 用户账户仓储（client-api 账户聚合：注册/登录/资料/改密）。
 * 与 UserRepository 的分工：那是计费管线的只读读模型（存在性/限额/费率卡），
 * 本仓储是账户生命周期的写侧——建号（唯一索引兜底并发）、改密原子推进会话失效线。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

/** 登录读形状（密码校验 + 账号状态 + 会话失效线三要素齐备） */
export interface LocalAccountRow {
  id: number;
  subject: string;
  email: string | null;
  displayName: string | null;
  passwordHash: string | null;
  status: number;
  /** 会话失效线（R5-2）：iat 早于此时间点的会话一律拒绝；null=不限 */
  sessionInvalidBefore: Date | null;
  createdAt: Date;
}

/** 用户账户仓储（无状态；方法统一接收 RepoContext） */
export class UserAccountRepository {
  private readonly projection = {
    id: users.id,
    subject: users.subject,
    email: users.email,
    displayName: users.displayName,
    passwordHash: users.passwordHash,
    status: users.status,
    sessionInvalidBefore: users.sessionInvalidBefore,
    createdAt: users.createdAt,
  };

  /** 本地账号按邮箱查找（issuer='local'；登录与注册占用检查共用） */
  async findByLocalEmail(c: RepoContext, email: string): Promise<LocalAccountRow | null> {
    const [row] = await c.db.select(this.projection).from(users).where(
      and(eq(users.issuer, 'local'), eq(users.email, email)),
    );
    return row ?? null;
  }

  async findById(c: RepoContext, userId: number): Promise<LocalAccountRow | null> {
    const [row] = await c.db.select(this.projection).from(users).where(eq(users.id, userId));
    return row ?? null;
  }

  /**
   * 建本地账号（并发撞邮箱由 users_local_email_uq 部分唯一索引兜底——
   * 抛 23505，语义化翻译在 app service）。
   */
  async insertLocalUser(
    c: RepoContext,
    input: { email: string; passwordHash: string; displayName: string },
  ): Promise<{ id: number; createdAt: Date }> {
    const [row] = await tx(c)
      .insert(users)
      .values({
        issuer: 'local',
        subject: input.email,
        identityProvider: 'local',
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
      })
      .returning({ id: users.id, createdAt: users.createdAt });
    return row!;
  }

  /** 登录成功时间戳（尽力而为的运营指标，不参与任何判定） */
  async touchLastLogin(c: RepoContext, userId: number): Promise<void> {
    await tx(c)
      .update(users)
      .set({ lastLoginAt: sql`clock_timestamp()` })
      .where(eq(users.id, userId));
  }

  /** 自助改显示名（1..64 位；无唯一约束） */
  async updateDisplayName(
    c: RepoContext,
    input: { userId: number; displayName: string },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(users)
      .set({ displayName: input.displayName, updatedAt: sql`clock_timestamp()` })
      .where(eq(users.id, input.userId))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /**
   * 改密（单语句原子）：哈希更新 + 会话失效线同拍推进到 now——
   * 拆两条语句会开「新密已存、旧会话仍活」的窗口，这里结构性杜绝。
   */
  async updatePassword(
    c: RepoContext,
    input: { userId: number; passwordHash: string; invalidBefore: Date },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(users)
      .set({
        passwordHash: input.passwordHash,
        sessionInvalidBefore: input.invalidBefore,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(users.id, input.userId))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /** OAuth 账号按 (issuer, subject) 查（find-or-create 的读侧；无密码哈希） */
  async findByOAuthSubject(
    c: RepoContext,
    issuer: string,
    subject: string,
  ): Promise<{ id: number; email: string | null; status: number } | null> {
    const [row] = await c.db
      .select({ id: users.id, email: users.email, status: users.status })
      .from(users)
      .where(and(eq(users.issuer, issuer), eq(users.subject, subject)));
    return row ?? null;
  }

  /** OAuth 建号（issuer=provider；并发同号由 users_issuer_subject_uq 兜底回查） */
  async insertOAuthUser(
    c: RepoContext,
    input: { issuer: string; subject: string; email: string | null; displayName: string },
  ): Promise<{ id: number; email: string | null; status: number }> {
    const [row] = await tx(c)
      .insert(users)
      .values({
        issuer: input.issuer,
        subject: input.subject,
        identityProvider: input.issuer,
        email: input.email,
        displayName: input.displayName.slice(0, 64),
      })
      .returning({ id: users.id, email: users.email, status: users.status });
    return row!;
  }
}
