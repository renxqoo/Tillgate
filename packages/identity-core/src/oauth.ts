/** OAuth 绑定动词：(provider, subject) 全局唯一=防劫持；一人一 provider 一绑定；解绑有凭据集守卫 */
import { and, eq, ne } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  IdentityInternalError,
  LastCredentialError,
  OAuthLinkNotFoundError,
  ProviderAlreadyLinkedError,
} from './errors.js';
import { advisoryLock, credentialSetLockKey, runEffect, runTx, type DbLike } from './internal.js';
import { identityOauthLinks, identityPasswords } from './schema.js';
import { assertOAuthSubject, assertUserId, guardProvider, normalizeDisplayEmail } from './validation.js';
import type { IdentityContext } from './context.js';
import type {
  FindOAuthUserInput,
  LinkOAuthInput,
  LinkOAuthResult,
  UnlinkOAuthInput,
  UnlinkOAuthResult,
} from './types.js';

export async function findOAuthUser(
  db: NodePgDatabase,
  input: FindOAuthUserInput,
  ctx: IdentityContext,
): Promise<number | null> {
  const provider = guardProvider(input.provider, ctx.guards);
  const subject = assertOAuthSubject(input.subject);
  const rows = await db
    .select({ userId: identityOauthLinks.userId })
    .from(identityOauthLinks)
    .where(and(eq(identityOauthLinks.provider, provider), eq(identityOauthLinks.subject, subject)))
    .limit(1);
  return rows[0]?.userId ?? null;
}

export async function linkOAuth(
  db: NodePgDatabase,
  input: LinkOAuthInput,
  ctx: IdentityContext,
): Promise<LinkOAuthResult> {
  const provider = guardProvider(input.provider, ctx.guards);
  const subject = assertOAuthSubject(input.subject);
  const userId = assertUserId(input.userId);
  const email = normalizeDisplayEmail(input.email ?? null);

  const exec = async (tx: DbLike): Promise<LinkOAuthResult> => {
    await advisoryLock(tx, credentialSetLockKey(userId));
    // onConflictDoNothing（不带 target）覆盖两个唯一索引——冲突不炸事务，读回定位冲突面
    const inserted = await tx
      .insert(identityOauthLinks)
      .values({ userId, provider, subject, email })
      .onConflictDoNothing()
      .returning({ id: identityOauthLinks.id });
    if (inserted.length > 0) {
      return { linkId: inserted[0]!.id, replayed: false };
    }
    const bySubject = await tx
      .select({ id: identityOauthLinks.id, userId: identityOauthLinks.userId })
      .from(identityOauthLinks)
      .where(and(eq(identityOauthLinks.provider, provider), eq(identityOauthLinks.subject, subject)))
      .limit(1);
    const byUser = await tx
      .select({ id: identityOauthLinks.id })
      .from(identityOauthLinks)
      .where(and(eq(identityOauthLinks.userId, userId), eq(identityOauthLinks.provider, provider)))
      .limit(1);
    const sub = bySubject[0];
    const usr = byUser[0];
    if (sub != null && usr != null && sub.id === usr.id && sub.userId === userId) {
      return { linkId: sub.id, replayed: true };
    }
    if (sub != null && sub.userId !== userId) {
      throw new ProviderAlreadyLinkedError(provider, 'provider_identity_taken');
    }
    if (usr != null) {
      throw new ProviderAlreadyLinkedError(provider, 'user_already_linked');
    }
    throw new IdentityInternalError('link_oauth', 'unique conflict but readback found no row on either side');
  };

  const result = input.tx != null ? await exec(input.tx) : await runTx(db, exec);
  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'user',
      action: result.replayed ? 'oauth.link.replay' : 'oauth.link',
      targetType: 'oauth_link',
      targetId: result.linkId,
      detail: { userId, provider },
    }),
  );
  return result;
}

export async function unlinkOAuth(
  db: NodePgDatabase,
  input: UnlinkOAuthInput,
  ctx: IdentityContext,
): Promise<UnlinkOAuthResult> {
  const provider = guardProvider(input.provider, ctx.guards);
  const userId = assertUserId(input.userId);

  const result = await runTx(db, async (tx) => {
    // 凭据集串行：与挂凭据/解绑互斥——「删后仍留登录方式」的判定在临界区内完成
    await advisoryLock(tx, credentialSetLockKey(userId));
    const links = await tx
      .select({ id: identityOauthLinks.id })
      .from(identityOauthLinks)
      .where(and(eq(identityOauthLinks.userId, userId), eq(identityOauthLinks.provider, provider)))
      .for('update')
      .limit(1);
    const link = links[0];
    if (link == null) {
      throw new OAuthLinkNotFoundError(userId, provider);
    }
    const password = await tx
      .select({ userId: identityPasswords.userId })
      .from(identityPasswords)
      .where(eq(identityPasswords.userId, userId))
      .limit(1);
    const otherLinks = await tx
      .select({ id: identityOauthLinks.id })
      .from(identityOauthLinks)
      .where(and(eq(identityOauthLinks.userId, userId), ne(identityOauthLinks.id, link.id)))
      .limit(1);
    if (password.length === 0 && otherLinks.length === 0) {
      throw new LastCredentialError(userId);
    }
    await tx.delete(identityOauthLinks).where(eq(identityOauthLinks.id, link.id));
    return { unlinked: true as const };
  });

  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'user',
      action: 'oauth.unlink',
      targetType: 'oauth_link',
      targetId: userId,
      detail: { userId, provider },
    }),
  );
  return result;
}
