/**
 * OAuth 绑定 store postgres 实现:绑定(锁内 onConflictDoNothing 双索引兜底 + 读回分类)、
 * 解绑(锁内 for update + 最后凭据守卫)。SQL 与 v1 oauth.ts 逐语义对齐。
 */
import { and, eq, ne } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { identityOauthLinks, identityPasswords } from '@tillgate/db';
import { DefectError } from '@tillgate/errors';
import type { LinkOutcome, OAuthStore, UnlinkOutcome } from '../../ports/oauth-store.js';

export const oauthQueries: OAuthStore = {
  async findUser(db: DbLike, input: { provider: string; subject: string }): Promise<number | null> {
    const rows = await db
      .select({ userId: identityOauthLinks.userId })
      .from(identityOauthLinks)
      .where(
        and(
          eq(identityOauthLinks.provider, input.provider),
          eq(identityOauthLinks.subject, input.subject),
        ),
      )
      .limit(1);
    return rows[0]?.userId ?? null;
  },

  async link(
    db: DbLike,
    input: { userId: number; provider: string; subject: string; email: string | null },
  ): Promise<LinkOutcome> {
    // onConflictDoNothing(不带 target)覆盖两个唯一索引——冲突不炸事务,读回定位冲突面
    const inserted = await db
      .insert(identityOauthLinks)
      .values({
        userId: input.userId,
        provider: input.provider,
        subject: input.subject,
        email: input.email,
      })
      .onConflictDoNothing()
      .returning({ id: identityOauthLinks.id });
    if (inserted.length > 0) {
      return { status: 'linked', linkId: inserted[0]!.id };
    }
    const bySubject = await db
      .select({ id: identityOauthLinks.id, userId: identityOauthLinks.userId })
      .from(identityOauthLinks)
      .where(
        and(
          eq(identityOauthLinks.provider, input.provider),
          eq(identityOauthLinks.subject, input.subject),
        ),
      )
      .limit(1);
    const byUser = await db
      .select({ id: identityOauthLinks.id })
      .from(identityOauthLinks)
      .where(
        and(
          eq(identityOauthLinks.userId, input.userId),
          eq(identityOauthLinks.provider, input.provider),
        ),
      )
      .limit(1);
    const sub = bySubject[0];
    const usr = byUser[0];
    if (sub != null && usr != null && sub.id === usr.id && sub.userId === input.userId) {
      return { status: 'replay', linkId: sub.id };
    }
    if (sub != null && sub.userId !== input.userId) {
      return { status: 'provider_identity_taken' };
    }
    if (usr != null) {
      return { status: 'user_already_linked' };
    }
    // 不可能分支:唯一冲突但读回两侧皆无行
    throw new DefectError('link_oauth readback found no row on either side', 'identity.defect', {
      operation: 'link_oauth',
    });
  },

  async unlink(db: DbLike, input: { userId: number; provider: string }): Promise<UnlinkOutcome> {
    const links = await db
      .select({ id: identityOauthLinks.id })
      .from(identityOauthLinks)
      .where(
        and(
          eq(identityOauthLinks.userId, input.userId),
          eq(identityOauthLinks.provider, input.provider),
        ),
      )
      .for('update')
      .limit(1);
    const link = links[0];
    if (link == null) {
      return { status: 'not_found' };
    }
    const password = await db
      .select({ userId: identityPasswords.userId })
      .from(identityPasswords)
      .where(eq(identityPasswords.userId, input.userId))
      .limit(1);
    const otherLinks = await db
      .select({ id: identityOauthLinks.id })
      .from(identityOauthLinks)
      .where(and(eq(identityOauthLinks.userId, input.userId), ne(identityOauthLinks.id, link.id)))
      .limit(1);
    if (password.length === 0 && otherLinks.length === 0) {
      return { status: 'last_credential' };
    }
    await db.delete(identityOauthLinks).where(eq(identityOauthLinks.id, link.id));
    return { status: 'unlinked', linkId: link.id };
  },
};
