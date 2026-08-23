/**
 * accounts 表只读面（app-face join；MIGRATION §8 待办——后迁 accounts facade 动词）：
 * 注册期邮箱占用预检 / 会话与登录链的账户状态读 / 最近登录时间落库。
 */
import { eq } from 'drizzle-orm';
import { users, type Db } from '@tokenlens/db';

export interface AccountRead {
  emailTaken(email: string): Promise<boolean>;
  /** 用户状态（null = 用户不存在） */
  activeUserStatus(userId: number): Promise<number | null>;
  touchLastLogin(userId: number): Promise<void>;
}

export function createAccountRead(db: Db): AccountRead {
  return {
    async emailTaken(email) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows.length > 0;
    },
    async activeUserStatus(userId) {
      const rows = await db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.status ?? null;
    },
    async touchLastLogin(userId) {
      const now = new Date();
      await db
        .update(users)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(users.id, userId));
    },
  };
}
