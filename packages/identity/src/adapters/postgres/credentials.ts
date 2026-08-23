/**
 * 凭据 store postgres 实现:标识绑定(advisoryLock + onConflictDoNothing + 读回分类)
 * 与凭据查询。SQL 与 v1 identity-core 逐语义对齐(IMPLEMENTATION §4 口径 9)。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DbLike } from '@tokenlens/db';
import { identityCredentials, identityPasswords } from '@tokenlens/db';
import { DefectError } from '@tokenlens/errors';
import type { NormalizedIdentifier } from '../../domain/identifier.js';
import type { CredentialStore, RegisterCredentialOutcome } from '../../ports/credential-store.js';

export const credentialQueries: Pick<
  CredentialStore,
  | 'registerCredential'
  | 'findPasswordHashByIdentifier'
  | 'loadPasswordHash'
  | 'findDeliveryIdentifier'
  | 'hasPassword'
> = {
  async registerCredential(
    db: DbLike,
    input: { userId: number; identifier: NormalizedIdentifier },
  ): Promise<RegisterCredentialOutcome> {
    const inserted = await db
      .insert(identityCredentials)
      .values({
        userId: input.userId,
        identifierKind: input.identifier.kind,
        identifierValue: input.identifier.value,
      })
      .onConflictDoNothing({
        target: [identityCredentials.identifierKind, identityCredentials.identifierValue],
      })
      .returning({ id: identityCredentials.id });
    if (inserted.length > 0) {
      return { status: 'created', credentialId: inserted[0]!.id };
    }
    const existing = await db
      .select({ id: identityCredentials.id, userId: identityCredentials.userId })
      .from(identityCredentials)
      .where(
        and(
          eq(identityCredentials.identifierKind, input.identifier.kind),
          eq(identityCredentials.identifierValue, input.identifier.value),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) {
      // 不可能分支:唯一冲突但读回无行
      throw new DefectError('register_credential readback found no row', 'identity.defect', {
        operation: 'register_credential',
      });
    }
    if (row.userId !== input.userId) {
      return { status: 'taken' };
    }
    return { status: 'replay', credentialId: row.id };
  },

  async findPasswordHashByIdentifier(
    db: DbLike,
    identifier: NormalizedIdentifier,
  ): Promise<{ userId: number; passwordHash: string } | null> {
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
    return rows[0] ?? null;
  },

  async loadPasswordHash(db: DbLike, userId: number): Promise<string | null> {
    const rows = await db
      .select({ passwordHash: identityPasswords.passwordHash })
      .from(identityPasswords)
      .where(eq(identityPasswords.userId, userId))
      .limit(1);
    return rows[0]?.passwordHash ?? null;
  },

  async findDeliveryIdentifier(
    db: DbLike,
    userId: number,
  ): Promise<{ kind: 'email' | 'phone'; value: string } | null> {
    // email 优先、phone 次之(注册序无关,确定性排序)
    const rows = await db
      .select({
        kind: identityCredentials.identifierKind,
        value: identityCredentials.identifierValue,
      })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, userId))
      .orderBy(
        sql`case ${identityCredentials.identifierKind} when 'email' then 0 when 'phone' then 1 else 2 end`,
        identityCredentials.id,
      )
      .limit(1);
    const cred = rows[0];
    if (!cred || (cred.kind !== 'email' && cred.kind !== 'phone')) return null;
    return { kind: cred.kind, value: cred.value };
  },

  async hasPassword(db: DbLike, userId: number): Promise<boolean> {
    const rows = await db
      .select({ userId: identityPasswords.userId })
      .from(identityPasswords)
      .where(eq(identityPasswords.userId, userId))
      .limit(1);
    return rows.length > 0;
  },
};
