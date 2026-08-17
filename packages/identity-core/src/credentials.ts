/** 凭据动词：标识 ↔ userId 的绑定（一个标识一个账号；同用户重挂=幂等重放） */
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { IdentifierTakenError, IdentityInternalError, InvalidInputError } from './errors.js';
import { advisoryLock, credentialSetLockKey, runEffect, runTx, type DbLike } from './internal.js';
import { identityCredentials, identityPasswords } from './schema.js';
import { assertUserId, normalizeIdentifier } from './validation.js';
import { PASSWORD_HASH_RE } from './password.js';
import type { IdentityContext } from './context.js';
import type { RegisterCredentialInput, RegisterCredentialResult } from './types.js';

export async function registerCredential(
  db: NodePgDatabase,
  input: RegisterCredentialInput,
  ctx: IdentityContext,
): Promise<RegisterCredentialResult> {
  const userId = assertUserId(input.userId);
  const identifier = normalizeIdentifier(input.identifier, ctx.guards);
  if (input.passwordHash != null && !PASSWORD_HASH_RE.test(input.passwordHash)) {
    throw new InvalidInputError(
      'passwordHash',
      'must be produced by hashPassword (scrypt:N:r:p:<saltHex>:<hashHex>)',
    );
  }

  const exec = async (tx: DbLike): Promise<RegisterCredentialResult> => {
    // 凭据集串行：与解绑/改密互斥（「登录方式集合」的变更是同键临界区）
    await advisoryLock(tx, credentialSetLockKey(userId));
    const inserted = await tx
      .insert(identityCredentials)
      .values({ userId, identifierKind: identifier.kind, identifierValue: identifier.value })
      .onConflictDoNothing({ target: [identityCredentials.identifierKind, identityCredentials.identifierValue] })
      .returning({ id: identityCredentials.id });
    if (inserted.length > 0) {
      if (input.passwordHash != null) {
        await tx
          .insert(identityPasswords)
          .values({ userId, passwordHash: input.passwordHash })
          .onConflictDoUpdate({
            target: identityPasswords.userId,
            set: { passwordHash: input.passwordHash, updatedAt: new Date() },
          });
      }
      return { credentialId: inserted[0]!.id, replayed: false };
    }
    const existing = await tx
      .select({ id: identityCredentials.id, userId: identityCredentials.userId })
      .from(identityCredentials)
      .where(
        and(
          eq(identityCredentials.identifierKind, identifier.kind),
          eq(identityCredentials.identifierValue, identifier.value),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) {
      throw new IdentityInternalError('register_credential', 'unique conflict but readback found no row');
    }
    if (row.userId !== userId) {
      throw new IdentifierTakenError(identifier.kind, identifier.value);
    }
    return { credentialId: row.id, replayed: true };
  };

  const result = input.tx != null ? await exec(input.tx) : await runTx(db, exec);
  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'admin',
      action: result.replayed ? 'credential.replay' : 'credential.register',
      targetType: 'credential',
      targetId: result.credentialId,
      detail: { userId, kind: identifier.kind, value: identifier.value },
    }),
  );
  return result;
}
