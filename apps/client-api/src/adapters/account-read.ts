/**
 * accounts 表只读面（app-face join；MIGRATION §8 待办——后迁 accounts facade 动词）：
 * 注册期邮箱占用预检 / 会话与登录链的账户状态读 / 最近登录时间落库。
 */
import { and, eq } from 'drizzle-orm';
import { identityCredentials, users, type Db } from '@tillgate/db';

export interface AccountRead {
  emailTaken(email: string): Promise<boolean>;
  /** 用户状态（null = 用户不存在） */
  activeUserStatus(userId: number): Promise<number | null>;
  /** 邮箱 → (id, 状态)——找回密码定位目标;null=不存在 */
  userByEmail(email: string): Promise<{ id: number; status: number } | null>;
  touchLastLogin(userId: number): Promise<void>;
}

export function createAccountRead(db: Db): AccountRead {
  return {
    // 预检必须覆盖 identity_credentials(权威命名空间):只查 users 表看不见管理端/
    // 其他 realm 占用的邮箱,会放行到 verify 末段绑凭据才失败,留下无法登录的孤儿 users 行
    async emailTaken(email) {
      const [byUsers, byCredential] = await Promise.all([
        db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1),
        db
          .select({ id: identityCredentials.id })
          .from(identityCredentials)
          .where(
            and(
              eq(identityCredentials.identifierKind, 'email'),
              eq(identityCredentials.identifierValue, email),
            ),
          )
          .limit(1),
      ]);
      return byUsers.length > 0 || byCredential.length > 0;
    },
    async activeUserStatus(userId) {
      const rows = await db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.status ?? null;
    },
    async userByEmail(email) {
      const rows = await db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows[0] ?? null;
    },
    async touchLastLogin(userId) {
      const now = new Date();
      await db.update(users).set({ lastLoginAt: now, updatedAt: now }).where(eq(users.id, userId));
    },
  };
}
