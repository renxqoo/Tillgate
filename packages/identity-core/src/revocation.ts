/** 会话吊销锚点：每用户一行，GREATEST 单调推进——无状态 JWT 的吊销真相 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { IdentityInternalError, InvalidInputError } from './errors.js';
import { runEffect, type DbLike } from './internal.js';
import { identitySessionAnchors } from './schema.js';
import { assertUserId } from './validation.js';
import type { IdentityContext } from './context.js';
import type { RevokeSessionsInput, RevokeSessionsResult, SessionValidAtInput } from './types.js';

/**
 * 推进吊销线（单调）：早于此线的会话全部失效。
 * GREATEST 保证管理端「回填历史时刻」不会放松已收紧的线。
 */
export async function advanceAnchor(dbLike: DbLike, userId: number, at: Date): Promise<Date> {
  const rows = await dbLike
    .insert(identitySessionAnchors)
    .values({ userId, invalidBefore: at })
    .onConflictDoUpdate({
      target: identitySessionAnchors.userId,
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
  db: NodePgDatabase,
  input: RevokeSessionsInput,
  ctx: IdentityContext,
): Promise<RevokeSessionsResult> {
  const userId = assertUserId(input.userId);
  const invalidBefore = await advanceAnchor(db, userId, input.at ?? ctx.clock());
  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'admin',
      action: 'sessions.revoke',
      targetType: 'user',
      targetId: userId,
      detail: { invalidBefore: invalidBefore.toISOString() },
    }),
  );
  return { invalidBefore: invalidBefore.toISOString() };
}

/** 会话签发时刻是否仍有效（无锚点行 = 全有效；iat 用毫秒语义） */
export async function sessionValidAt(
  db: NodePgDatabase,
  input: SessionValidAtInput,
): Promise<boolean> {
  const userId = assertUserId(input.userId);
  const iatMs = input.iat instanceof Date ? input.iat.getTime() : input.iat;
  if (typeof iatMs !== 'number' || !Number.isFinite(iatMs)) {
    throw new InvalidInputError('iat', 'must be a Date or epoch milliseconds (JWT iat seconds × 1000)');
  }
  const rows = await db
    .select({ invalidBefore: identitySessionAnchors.invalidBefore })
    .from(identitySessionAnchors)
    .where(eq(identitySessionAnchors.userId, userId))
    .limit(1);
  const anchor = rows[0]?.invalidBefore;
  if (anchor == null) return true;
  return iatMs >= anchor.getTime();
}
