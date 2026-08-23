/**
 * 管理员资料 postgres 适配器（ports/admin-store 唯一实现）。
 * 时间戳一律 SQL now()（touchLastLogin/updatedAt）；投影不含密码/2FA 密钥列——
 * 凭据单一真相在 identity 七表（G1/G2 裁决,admins.password_hash 冻结只读不投影）。
 */
import { eq, sql } from 'drizzle-orm';
import { admins } from '@tokenlens/db';
import type { DbLike } from '@tokenlens/db';
import type { AdminRecord, AdminStore } from '../../ports/admin-store';

const projection = {
  id: admins.id,
  email: admins.email,
  displayName: admins.displayName,
  status: admins.status,
  twoFactorEnabled: admins.twoFactorEnabled,
  lastLoginAt: admins.lastLoginAt,
  createdAt: admins.createdAt,
};

export const postgresAdminStore: AdminStore = {
  async findById(db: DbLike, id: number): Promise<AdminRecord | null> {
    const rows = await db.select(projection).from(admins).where(eq(admins.id, id)).limit(1);
    return (rows[0] as AdminRecord | undefined) ?? null;
  },

  async findByEmail(db: DbLike, email: string): Promise<AdminRecord | null> {
    const rows = await db.select(projection).from(admins).where(eq(admins.email, email)).limit(1);
    return (rows[0] as AdminRecord | undefined) ?? null;
  },

  async touchLastLogin(db: DbLike, id: number): Promise<void> {
    await db
      .update(admins)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(admins.id, id));
  },

  async setTwoFactorEnabled(db: DbLike, input: { adminId: number; enabled: boolean }) {
    await db
      .update(admins)
      .set({ twoFactorEnabled: input.enabled, updatedAt: sql`now()` })
      .where(eq(admins.id, input.adminId));
  },
};
