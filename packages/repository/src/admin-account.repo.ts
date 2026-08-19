/**
 * admins 管理员账户仓储：管理面登录 / 2FA 开关 / 改密（会话失效线同拍推进）。
 * 账户域语义（哑哈希防枚举、验证码两步流）在 admin-api 服务层；本层只做行存取。
 */
import { eq } from 'drizzle-orm';
import { admins } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

export interface AdminAccountRow {
  id: number;
  email: string;
  displayName: string | null;
  passwordHash: string;
  status: number;
  twoFactorEnabled: boolean;
  sessionInvalidBefore: Date | null;
  lastLoginAt: Date | null;
}

const ACCOUNT_COLUMNS = {
  id: admins.id,
  email: admins.email,
  displayName: admins.displayName,
  passwordHash: admins.passwordHash,
  status: admins.status,
  twoFactorEnabled: admins.twoFactorEnabled,
  sessionInvalidBefore: admins.sessionInvalidBefore,
  lastLoginAt: admins.lastLoginAt,
};

/** 管理员账户仓储（无状态；方法统一接收 RepoContext） */
export class AdminAccountRepository {
  async findByEmail(c: RepoContext, email: string): Promise<AdminAccountRow | null> {
    const [row] = await c.db.select(ACCOUNT_COLUMNS).from(admins).where(eq(admins.email, email));
    return (row as AdminAccountRow) ?? null;
  }

  async findById(c: RepoContext, adminId: number): Promise<AdminAccountRow | null> {
    const [row] = await c.db.select(ACCOUNT_COLUMNS).from(admins).where(eq(admins.id, adminId));
    return (row as AdminAccountRow) ?? null;
  }

  async touchLastLogin(c: RepoContext, adminId: number): Promise<void> {
    await c.db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, adminId));
  }

  /**
   * 改密：新哈希 + 会话失效线（R5-2）原子单 UPDATE——0 行 = 管理员不存在。
   * 失效线由调用方取「现在」，新 token 在事务提交后签发（iat 严格在线后）。
   */
  async updatePassword(
    c: RepoContext,
    input: { adminId: number; passwordHash: string; invalidBefore: Date },
  ): Promise<boolean> {
    const rows = await c.db
      .update(admins)
      .set({
        passwordHash: input.passwordHash,
        sessionInvalidBefore: input.invalidBefore,
        updatedAt: new Date(),
      })
      .where(eq(admins.id, input.adminId))
      .returning({ id: admins.id });
    return rows.length > 0;
  }

  async setTwoFactorEnabled(
    c: RepoContext,
    input: { adminId: number; enabled: boolean },
  ): Promise<boolean> {
    const rows = await c.db
      .update(admins)
      .set({ twoFactorEnabled: input.enabled, updatedAt: new Date() })
      .where(eq(admins.id, input.adminId))
      .returning({ id: admins.id });
    return rows.length > 0;
  }
}
