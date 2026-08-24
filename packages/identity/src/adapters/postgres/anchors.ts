/**
 * 会话吊销锚点 store postgres 实现:upsert + GREATEST 单调(管理端回填历史时刻
 * 不会放松已收紧的线);at 缺省 = SQL now()(B28:锚点推进不受应用时钟回拨影响)。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { identitySessionAnchors } from '@tillgate/db';
import { DefectError } from '@tillgate/errors';
import type { AnchorStore } from '../../ports/anchor-store.js';

export const anchorQueries: AnchorStore = {
  async advanceAnchor(
    db: DbLike,
    input: { realm: string; userId: number; at?: Date },
  ): Promise<string> {
    const rows =
      input.at != null
        ? await db
            .insert(identitySessionAnchors)
            .values({ realm: input.realm, userId: input.userId, invalidBefore: input.at })
            .onConflictDoUpdate({
              target: [identitySessionAnchors.realm, identitySessionAnchors.userId],
              set: {
                invalidBefore: sql`greatest(identity_session_anchors.invalid_before, ${input.at})`,
                updatedAt: sql`now()`,
              },
            })
            .returning({ invalidBefore: identitySessionAnchors.invalidBefore })
        : await db
            .insert(identitySessionAnchors)
            .values({ realm: input.realm, userId: input.userId, invalidBefore: sql`now()` })
            .onConflictDoUpdate({
              target: [identitySessionAnchors.realm, identitySessionAnchors.userId],
              set: {
                invalidBefore: sql`greatest(identity_session_anchors.invalid_before, now())`,
                updatedAt: sql`now()`,
              },
            })
            .returning({ invalidBefore: identitySessionAnchors.invalidBefore });
    if (rows.length === 0) {
      throw new DefectError('advance_anchor upsert returned no row', 'identity.defect', {
        operation: 'advance_anchor',
      });
    }
    return rows[0]!.invalidBefore.toISOString();
  },

  async readAnchor(db: DbLike, input: { realm: string; userId: number }): Promise<string | null> {
    const rows = await db
      .select({ invalidBefore: identitySessionAnchors.invalidBefore })
      .from(identitySessionAnchors)
      .where(
        and(
          eq(identitySessionAnchors.realm, input.realm),
          eq(identitySessionAnchors.userId, input.userId),
        ),
      )
      .limit(1);
    return rows[0]?.invalidBefore.toISOString() ?? null;
  },
};
