/** 密码动词：authenticate（恒定时间统一错误）/ changePassword / resetPassword（均推进吊销线） */
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { IdentityInternalError, InvalidCredentialsError } from './errors.js';
import { advisoryLock, credentialSetLockKey, runEffect, runTx } from './internal.js';
import { identityCredentials, identityPasswords } from './schema.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password.js';
import { assertUserId, DEFAULT_REALM, normalizeIdentifier } from './validation.js';
import { advanceAnchor } from './revocation.js';
import type { IdentityContext } from './context.js';
import type {
  AuthenticateInput,
  ChangePasswordInput,
  PasswordMutationResult,
  ResetPasswordInput,
} from './types.js';

/**
 * 密码认证：标识+密码 → userId。
 * 统一口径：标识不存在、密码错误、账号无密码 → 同一个 InvalidCredentialsError
 * （哑哈希保证等量 scrypt 计算，响应耗时一致——防枚举）。状态检查（封禁等）是业务域，不在此处。
 */
export async function authenticate(
  db: NodePgDatabase,
  input: AuthenticateInput,
  ctx: IdentityContext,
): Promise<{ userId: number }> {
  const identifier = normalizeIdentifier(input.identifier, ctx.guards);
  const rows = await db
    .select({ userId: identityCredentials.userId, passwordHash: identityPasswords.passwordHash })
    .from(identityCredentials)
    .innerJoin(identityPasswords, eq(identityPasswords.userId, identityCredentials.userId))
    .where(
      and(
        eq(identityCredentials.identifierKind, identifier.kind),
        eq(identityCredentials.identifierValue, identifier.value),
      ),
    )
    .limit(1);
  const row = rows[0];
  const ok = await verifyPassword(typeof input.password === 'string' ? input.password : '', row?.passwordHash ?? null);
  if (!row || !ok) {
    throw new InvalidCredentialsError();
  }
  return { userId: row.userId };
}

/** 读取存储哈希（changePassword 用；OAuth-only 账号无行） */
async function loadPasswordHash(db: NodePgDatabase, userId: number): Promise<string | null> {
  const rows = await db
    .select({ passwordHash: identityPasswords.passwordHash })
    .from(identityPasswords)
    .where(eq(identityPasswords.userId, userId))
    .limit(1);
  return rows[0]?.passwordHash ?? null;
}

/** 改密码：校验原密码 → 换哈希 + 吊销线推进（同一事务；无密码账号走 resetPassword） */
export async function changePassword(
  db: NodePgDatabase,
  input: ChangePasswordInput,
  ctx: IdentityContext,
): Promise<PasswordMutationResult> {
  const userId = assertUserId(input.userId);
  assertPasswordPolicy(input.newPassword, ctx.config.password);
  if (typeof input.currentPassword !== 'string') {
    throw new InvalidCredentialsError();
  }
  const stored = await loadPasswordHash(db, userId);
  if (stored == null) {
    throw new InvalidCredentialsError();
  }
  const currentOk = await verifyPassword(input.currentPassword, stored);
  if (!currentOk) {
    throw new InvalidCredentialsError();
  }
  const newHash = await hashPassword(input.newPassword);

  const invalidBefore = await runTx(db, async (tx) => {
    await advisoryLock(tx, credentialSetLockKey(userId));
    const updated = await tx
      .update(identityPasswords)
      .set({ passwordHash: newHash, updatedAt: sql`now()` })
      .where(eq(identityPasswords.userId, userId))
      .returning({ userId: identityPasswords.userId });
    if (updated.length === 0) {
      throw new IdentityInternalError('change_password', 'password row disappeared mid-transaction');
    }
    return advanceAnchor(tx, DEFAULT_REALM, userId, ctx.clock());
  });

  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'user',
      action: 'password.change',
      targetType: 'user',
      targetId: userId,
    }),
  );
  return { invalidBefore: invalidBefore.toISOString() };
}

/** 重置密码（找回/管理员）：免原密码，同样推进吊销线（重置即全网下线） */
export async function resetPassword(
  db: NodePgDatabase,
  input: ResetPasswordInput,
  ctx: IdentityContext,
): Promise<PasswordMutationResult> {
  const userId = assertUserId(input.userId);
  assertPasswordPolicy(input.newPassword, ctx.config.password);
  const newHash = await hashPassword(input.newPassword);

  const invalidBefore = await runTx(db, async (tx) => {
    await advisoryLock(tx, credentialSetLockKey(userId));
    await tx
      .insert(identityPasswords)
      .values({ userId, passwordHash: newHash })
      .onConflictDoUpdate({
        target: identityPasswords.userId,
        set: { passwordHash: newHash, updatedAt: sql`now()` },
      });
    return advanceAnchor(tx, DEFAULT_REALM, userId, ctx.clock());
  });

  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'admin',
      action: 'password.reset',
      targetType: 'user',
      targetId: userId,
    }),
  );
  return { invalidBefore: invalidBefore.toISOString() };
}
