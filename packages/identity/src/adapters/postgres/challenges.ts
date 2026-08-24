/**
 * 挑战 store postgres 实现。SQL 与 v1 identity-core challenge.ts 逐语义对齐:
 * 发码 = 锁内「冷却判定(clock_timestamp 墙钟)→ 替换旧挑战 → INSERT」;
 * 验码 = 单条 CAS UPDATE(计错 + 命中即消费);作废 = 幂等。
 * 冷却判定与剩余时长取自同一 SELECT 返回的 DB 钟与 issued_at,算术在 JS 完成
 * (同为 DB 事实,同一时钟口径,B14;避免 pg numeric → string 的驱动解析坑)。
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { identityChallenges } from '@tillgate/db';
import type { NormalizedIdentifier } from '../../domain/identifier.js';
import type {
  BeginChallengeOutcome,
  ChallengeStore,
  StoredChallengeTarget,
  VerifyChallengeResult,
} from '../../ports/challenge-store.js';

// 模块级:活挑战定位条件(identifier 优先;双空是域层契约违约,fail-closed 显式拒绝)
function liveTargetWhere(input: {
  identifier: NormalizedIdentifier | null;
  userId: number | null;
}) {
  if (input.identifier != null) {
    return and(
      eq(identityChallenges.identifierKind, input.identifier.kind),
      eq(identityChallenges.identifierValue, input.identifier.value),
    );
  }
  if (input.userId == null) {
    throw new Error('challenge target must carry identifier or userId');
  }
  return eq(identityChallenges.userId, input.userId);
}

// 模块级:锁内活挑战检查——冷却未过返回拒绝,已过则作废旧挑战(替换语义,让出部分唯一索引)
async function abortLiveChallengeIfCooling(
  db: DbLike,
  input: {
    kind: string;
    identifier: NormalizedIdentifier | null;
    userId: number | null;
    cooldownMs: number;
  },
): Promise<{ status: 'cooldown'; retryAfterMs: number } | null> {
  // clock_timestamp()(墙钟)而非 now()(事务起始时刻):advisory lock 等待期间
  // 事务的 now() 停在等待前,冷却判定会拒绝本应已冷却的旧挑战(v1 注释口径)。
  const [row] = await db
    .select({
      id: identityChallenges.id,
      issuedAt: identityChallenges.issuedAt,
      dbNow: sql<Date>`clock_timestamp()`,
    })
    .from(identityChallenges)
    .where(
      and(
        eq(identityChallenges.kind, input.kind),
        liveTargetWhere(input),
        isNull(identityChallenges.consumedAt),
        isNull(identityChallenges.abortedAt),
      ),
    )
    .for('update')
    .limit(1);
  if (row != null) {
    // sql<Date> 选择列不经列映射,驱动可能返回字符串——显式归一到毫秒
    const dbNowMs = new Date(row.dbNow as string | Date).getTime();
    const elapsedMs = dbNowMs - row.issuedAt.getTime();
    if (elapsedMs < input.cooldownMs) {
      return { status: 'cooldown', retryAfterMs: Math.max(0, input.cooldownMs - elapsedMs) };
    }
    await db
      .update(identityChallenges)
      .set({ abortedAt: sql`now()` })
      .where(eq(identityChallenges.id, row.id));
  }
  return null;
}

// 模块级:CAS 行 → 挑战目标(identifier 优先,否则 userId)
function storedTargetOf(row: {
  identifierKind: string | null;
  identifierValue: string | null;
  userId: number | null;
}): StoredChallengeTarget {
  return row.identifierValue != null
    ? {
        identifier: {
          kind: row.identifierKind as NormalizedIdentifier['kind'],
          value: row.identifierValue,
        },
        userId: null,
      }
    : { identifier: null, userId: row.userId };
}

export const challengeQueries: ChallengeStore = {
  async beginChallenge(
    db: DbLike,
    input: {
      challengeId: string;
      kind: string;
      identifier: NormalizedIdentifier | null;
      userId: number | null;
      codeHash: string;
      payload: Record<string, unknown> | null;
      ttlMs: number;
      cooldownMs: number;
      maxAttempts: number;
    },
  ): Promise<BeginChallengeOutcome> {
    const cooldown = await abortLiveChallengeIfCooling(db, input);
    if (cooldown != null) {
      return cooldown;
    }
    const inserted = await db
      .insert(identityChallenges)
      .values({
        id: input.challengeId,
        kind: input.kind,
        identifierKind: input.identifier?.kind ?? null,
        identifierValue: input.identifier?.value ?? null,
        userId: input.userId,
        codeHash: input.codeHash,
        payload: input.payload,
        maxAttempts: input.maxAttempts,
        expiresAt: sql`clock_timestamp() + make_interval(secs => ${input.ttlMs / 1000})`,
      })
      .onConflictDoNothing()
      .returning({ expiresAt: identityChallenges.expiresAt });
    const [insertedRow] = inserted;
    if (insertedRow == null) {
      // 锁内已清位仍撞唯一:同键并发发码穿过 advisory lock 的理论窗口——按冷却拒绝
      return { status: 'cooldown', retryAfterMs: input.cooldownMs };
    }
    return { status: 'inserted', expiresAt: insertedRow.expiresAt.toISOString() };
  },

  async verifyChallenge(
    db: DbLike,
    input: { challengeId: string; codeHash: string },
  ): Promise<VerifyChallengeResult> {
    // 单条 CAS:活挑战才可更新;命中哈希才消费;错误尝试必然累计(剩余次数由约束封顶)
    const rows = await db
      .update(identityChallenges)
      .set({
        attempts: sql`${identityChallenges.attempts} + 1`,
        consumedAt: sql`case when ${identityChallenges.codeHash} = ${input.codeHash} then now() else ${identityChallenges.consumedAt} end`,
      })
      .where(
        and(
          eq(identityChallenges.id, input.challengeId),
          isNull(identityChallenges.consumedAt),
          isNull(identityChallenges.abortedAt),
          gt(identityChallenges.expiresAt, sql`now()`),
          sql`${identityChallenges.attempts} < ${identityChallenges.maxAttempts}`,
        ),
      )
      .returning({
        consumedAt: identityChallenges.consumedAt,
        attempts: identityChallenges.attempts,
        maxAttempts: identityChallenges.maxAttempts,
        payload: identityChallenges.payload,
        identifierKind: identityChallenges.identifierKind,
        identifierValue: identityChallenges.identifierValue,
        userId: identityChallenges.userId,
      });

    const [row] = rows;
    if (row == null) {
      // 不存在 / 已消费 / 已作废 / 已过期 / 错次耗尽——统一口径,不泄露具体原因
      return { status: 'invalid' };
    }
    if (row.consumedAt == null) {
      return {
        status: 'wrong_code',
        remainingAttempts: Math.max(0, row.maxAttempts - row.attempts),
      };
    }
    return {
      status: 'consumed',
      target: storedTargetOf(row),
      payload: (row.payload as Record<string, unknown> | null) ?? null,
    };
  },

  async abortChallenge(db: DbLike, input: { challengeId: string }): Promise<{ aborted: boolean }> {
    const rows = await db
      .update(identityChallenges)
      .set({ abortedAt: sql`now()` })
      .where(
        and(
          eq(identityChallenges.id, input.challengeId),
          isNull(identityChallenges.consumedAt),
          isNull(identityChallenges.abortedAt),
        ),
      )
      .returning({ id: identityChallenges.id });
    return { aborted: rows.length > 0 };
  },
};
