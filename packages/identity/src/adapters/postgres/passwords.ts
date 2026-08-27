/**
 * 密码行 store postgres 实现:时间戳一律 SQL now();锁与临界区编排归 application
 * (验旧密必须发生在锁内)。
 */
import { eq, sql } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { identityPasswords } from '@tillgate/db';
import type { CredentialStore } from '../../ports/credential-store.js';

export const passwordQueries: Pick<
  CredentialStore,
  'upsertPassword' | 'updatePassword' | 'resetPassword'
> = {
  async upsertPassword(db: DbLike, input: { userId: number; passwordHash: string }): Promise<void> {
    await db
      .insert(identityPasswords)
      .values({ userId: input.userId, passwordHash: input.passwordHash })
      .onConflictDoUpdate({
        target: identityPasswords.userId,
        set: { passwordHash: input.passwordHash, updatedAt: sql`now()` },
      });
  },

  async updatePassword(
    db: DbLike,
    input: { userId: number; passwordHash: string },
  ): Promise<boolean> {
    const rows = await db
      .update(identityPasswords)
      .set({ passwordHash: input.passwordHash, updatedAt: sql`now()` })
      .where(eq(identityPasswords.userId, input.userId))
      .returning({ userId: identityPasswords.userId });
    return rows.length > 0;
  },

  async resetPassword(db: DbLike, input: { userId: number; passwordHash: string }): Promise<void> {
    await db
      .insert(identityPasswords)
      .values({ userId: input.userId, passwordHash: input.passwordHash })
      .onConflictDoUpdate({
        target: identityPasswords.userId,
        set: { passwordHash: input.passwordHash, updatedAt: sql`now()` },
      });
  },
};
