/** 会话吊销锚点：每 (realm, userId) 一行，GREATEST 单调推进——无状态 JWT 的吊销真相 */
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { IdentityInternalError, InvalidInputError } from './errors.js';
import { runEffect, type AnyPgDatabase, type DbLike } from './internal.js';
import { identitySessionAnchors } from './schema.js';
import { assertRealm, assertUserId, DEFAULT_REALM } from './validation.js';
import type { IdentityContext } from './context.js';
import type { RevokeSessionsInput, RevokeSessionsResult, SessionValidAtInput } from './types.js';

/**
 * 推进吊销线（单调）：早于此线的会话全部失效。
 * GREATEST 保证管理端「回填历史时刻」不会放松已收紧的线。
 * 可传 tx 与业务变更同事务（改密/重置/封禁同拍生效）。
 */
export async function advanceAnchor(
  dbLike: DbLike,
  realm: string,
  userId: number,
  at: Date,
): Promise<Date> {
  const rows = await dbLike
    .insert(identitySessionAnchors)
    .values({ realm, userId, invalidBefore: at })
    .onConflictDoUpdate({
      target: [identitySessionAnchors.realm, identitySessionAnchors.userId],
      set: {
        invalidBefore: sql`greatest(identity_session_anchors.invalid_before, excluded.invalid_before)`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ invalidBefore: identitySessionAnchors.invalidBefore });
  if (rows.length === 0) {
    throw new IdentityInternalError('advance_anchor', 'upsert returned no row');
  }
  return rows[0]!.invalidBefore;
}

export async function revokeSessions(
  db: AnyPgDatabase,
  input: RevokeSessionsInput,
  ctx: IdentityContext,
): Promise<RevokeSessionsResult> {
  const userId = assertUserId(input.userId);
  const realm = assertRealm(input.realm ?? DEFAULT_REALM);
  if (!ctx.guards.realms.has(realm)) {
    throw new InvalidInputError(
      'realm',
      `unknown realm '${realm}' (allowed: ${[...ctx.guards.realms].toSorted().join(', ')})`,
    );
  }
  const invalidBefore = await advanceAnchor(db, realm, userId, input.at ?? ctx.clock());
  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'admin',
      action: 'sessions.revoke',
      targetType: 'user',
      targetId: userId,
      detail: { realm, invalidBefore: invalidBefore.toISOString() },
    }),
  );
  return { invalidBefore: invalidBefore.toISOString() };
}

/** 会话签发时刻是否仍有效（无锚点行 = 全有效；iat 用毫秒语义） */
export async function sessionValidAt(
  db: AnyPgDatabase,
  input: SessionValidAtInput,
): Promise<boolean> {
  const userId = assertUserId(input.userId);
  const realm = assertRealm(input.realm ?? DEFAULT_REALM);
  const iatMs = input.iat instanceof Date ? input.iat.getTime() : input.iat;
  if (typeof iatMs !== 'number' || !Number.isFinite(iatMs)) {
    throw new InvalidInputError('iat', 'must be a Date or epoch milliseconds (JWT iat seconds × 1000)');
  }
  const rows = await db
    .select({ invalidBefore: identitySessionAnchors.invalidBefore })
    .from(identitySessionAnchors)
    .where(
      and(
        eq(identitySessionAnchors.realm, realm),
        eq(identitySessionAnchors.userId, userId),
      ),
    )
    .limit(1);
  const anchor = rows[0]?.invalidBefore;
  if (anchor == null) return true;
  return iatMs >= anchor.getTime();
}
