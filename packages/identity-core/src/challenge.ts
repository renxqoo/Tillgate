/**
 * 统一挑战动词（登录码/注册验证/密码找回/短信码——一个抽象四种业务）：
 *
 *   beginChallenge：advisory lock 串行同目标发码 → 冷却未过拒绝 / 已过替换旧挑战
 *                   → INSERT（码只存 sha256(code:challengeId) 加盐哈希）
 *                   → 提交后 effects.deliver 出境；投递失败立即作废挑战
 *   verifyChallenge：一条 UPDATE 完成「计错 + 命中即消费」（CAS 单往返，无读改写竞态）
 *   abortChallenge ：幂等作废
 *
 * 全部到期/冷却判定用 DB now()（单一时钟源）；活挑战唯一性另有部分唯一索引结构兜底。
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  ChallengeCooldownError,
  ChallengeInvalidError,
  CodeInvalidError,
  DeliveryFailedError,
  InvalidInputError,
  UndeliverableChallengeError,
} from './errors.js';
import { advisoryLock, challengeLockKey, runEffect, runTx } from './internal.js';
import { identityChallenges, identityCredentials } from './schema.js';
import { assertUserId, guardChallengeKind, isUuidLike, normalizeIdentifier } from './validation.js';
import type { IdentityContext } from './context.js';
import type { BeginChallengeInput, BeginChallengeResult, DeliveryChannel, IdentifierKind, VerifyChallengeResult } from './types.js';

const MAX_PAYLOAD_BYTES = 4096;

function channelFor(kind: IdentifierKind): DeliveryChannel | null {
  if (kind === 'email') return 'email';
  if (kind === 'phone') return 'sms';
  return null;
}

function codeHashOf(code: string, challengeId: string): string {
  return createHash('sha256').update(`${code}:${challengeId}`).digest('hex');
}

function randomCode(digits: number): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

function boundedOverride(value: number | undefined, fallback: number, field: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidInputError(field, `must be an integer in [${min}, ${max}], got ${String(value)}`);
  }
  return value;
}

function serializePayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (payload == null) return null;
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new InvalidInputError('payload', 'must be JSON-serializable');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new InvalidInputError('payload', `serialized size must be <= ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return payload;
}

export async function beginChallenge(
  db: NodePgDatabase,
  input: BeginChallengeInput,
  ctx: IdentityContext,
): Promise<BeginChallengeResult> {
  const kind = guardChallengeKind(input.kind, ctx.guards);

  // 目标归一 + 投递寻址（email→email 通道，phone→sms；username 无通道不可投递）
  let identifier: { kind: IdentifierKind; value: string } | null = null;
  let userId: number | null = null;
  let channel: DeliveryChannel;
  let to: string;
  if (input.target != null && 'identifier' in input.target && input.target.identifier != null) {
    const norm = normalizeIdentifier(input.target.identifier, ctx.guards);
    const c = channelFor(norm.kind);
    if (c == null) {
      throw new UndeliverableChallengeError(kind, `identifier kind '${norm.kind}' has no delivery channel`);
    }
    identifier = norm;
    channel = c;
    to = norm.value;
  } else if (input.target != null && 'userId' in input.target) {
    userId = assertUserId(input.target.userId);
    // 用户目标寻址：email 优先、phone 次之（注册序无关，确定性排序）
    const rows = await db
      .select({ kind: identityCredentials.identifierKind, value: identityCredentials.identifierValue })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, userId))
      .orderBy(
        sql`case ${identityCredentials.identifierKind} when 'email' then 0 when 'phone' then 1 else 2 end`,
        identityCredentials.id,
      )
      .limit(1);
    const cred = rows[0];
    const c = cred ? channelFor(cred.kind as IdentifierKind) : null;
    if (cred == null || c == null) {
      throw new UndeliverableChallengeError(kind, `user ${userId} has no email/phone credential`);
    }
    channel = c;
    to = cred.value;
  } else {
    throw new InvalidInputError('target', 'must be { identifier } or { userId }');
  }

  const payload = serializePayload(input.payload);
  const ttlMs = boundedOverride(input.ttlMs, ctx.config.challenge.ttlMs, 'ttlMs', 1_000, 86_400_000);
  const cooldownMs = boundedOverride(
    input.cooldownMs,
    ctx.config.challenge.cooldownMs,
    'cooldownMs',
    0,
    3_600_000,
  );
  const maxAttempts = boundedOverride(
    input.maxAttempts,
    ctx.config.challenge.maxAttempts,
    'maxAttempts',
    1,
    100,
  );

  const code = randomCode(ctx.config.challenge.digits);
  const challengeId = randomUUID();
  const targetKey = identifier ? `id:${identifier.kind}:${identifier.value}` : `user:${userId}`;

  const expiresAt = await runTx(db, async (tx) => {
    await advisoryLock(tx, challengeLockKey(kind, targetKey));
    // 活挑战（锁内读）：冷却未过 → 拒绝；已过 → 作废旧挑战（替换语义，让出部分唯一索引）
    const live = await tx
      .select({
        id: identityChallenges.id,
        issuedAt: identityChallenges.issuedAt,
        // clock_timestamp()（墙钟）而非 now()（事务起始时刻）：advisory lock 等待期间
        // 事务的 now() 停在等待前，冷却判定会拒绝本应已冷却的旧挑战
        cooled: sql<boolean>`${identityChallenges.issuedAt} <= clock_timestamp() - make_interval(secs => ${cooldownMs / 1000})`,
      })
      .from(identityChallenges)
      .where(
        and(
          eq(identityChallenges.kind, kind),
          identifier != null
            ? and(
                eq(identityChallenges.identifierKind, identifier.kind),
                eq(identityChallenges.identifierValue, identifier.value),
              )
            : eq(identityChallenges.userId, userId!),
          isNull(identityChallenges.consumedAt),
          isNull(identityChallenges.abortedAt),
        ),
      )
      .for('update')
      .limit(1);
    const row = live[0];
    if (row != null) {
      if (!row.cooled) {
        const elapsedMs = Date.now() - row.issuedAt.getTime();
        throw new ChallengeCooldownError(Math.max(0, cooldownMs - elapsedMs));
      }
      await tx
        .update(identityChallenges)
        .set({ abortedAt: sql`now()` })
        .where(eq(identityChallenges.id, row.id));
    }
    const inserted = await tx
      .insert(identityChallenges)
      .values({
        id: challengeId,
        kind,
        identifierKind: identifier?.kind ?? null,
        identifierValue: identifier?.value ?? null,
        userId,
        codeHash: codeHashOf(code, challengeId),
        payload,
        maxAttempts,
        expiresAt: sql`clock_timestamp() + make_interval(secs => ${ttlMs / 1000})`,
      })
      .onConflictDoNothing()
      .returning({ expiresAt: identityChallenges.expiresAt });
    if (inserted.length === 0) {
      // 锁内已清位仍撞唯一：同键并发发码穿过 advisory lock 的理论窗口——按冷却拒绝
      throw new ChallengeCooldownError(cooldownMs);
    }
    return inserted[0]!.expiresAt;
  });

  // 投递在提交后（deliver 不参与资金/安全事实事务）；失败立即作废挑战——
  // 用户侧语义：发不出去 = 流程没发生，可立刻重试（作废让出冷却位）。
  try {
    await ctx.effects?.deliver?.({ channel, to, kind, code, challengeId });
  } catch {
    await abortChallenge(db, { challengeId }).catch(() => undefined);
    throw new DeliveryFailedError(kind, channel);
  }
  await runEffect(() =>
    ctx.effects?.audit?.({
      actor: 'system',
      action: 'challenge.begin',
      targetType: 'challenge',
      targetId: challengeId,
      detail: { kind, channel, to },
    }),
  );
  return { challengeId, code, expiresAt: expiresAt.toISOString(), channel, to };
}

export async function verifyChallenge(
  db: NodePgDatabase,
  input: { challengeId: string; code: string },
): Promise<VerifyChallengeResult> {
  const challengeId = typeof input?.challengeId === 'string' ? input.challengeId : '';
  if (!isUuidLike(challengeId)) {
    throw new ChallengeInvalidError(challengeId || '<missing>');
  }
  const code = typeof input?.code === 'string' ? input.code.trim() : '';
  const hash = codeHashOf(code, challengeId);

  // 单条 CAS：活挑战才可更新；命中哈希才消费；错误尝试必然累计（剩余次数由约束封顶）
  const rows = await db
    .update(identityChallenges)
    .set({
      attempts: sql`${identityChallenges.attempts} + 1`,
      consumedAt: sql`case when ${identityChallenges.codeHash} = ${hash} then now() else ${identityChallenges.consumedAt} end`,
    })
    .where(
      and(
        eq(identityChallenges.id, challengeId),
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

  const row = rows[0];
  if (row == null) {
    // 不存在 / 已消费 / 已作废 / 已过期 / 错次耗尽——统一口径，不泄露具体原因
    throw new ChallengeInvalidError(challengeId);
  }
  if (row.consumedAt == null) {
    throw new CodeInvalidError(Math.max(0, row.maxAttempts - row.attempts));
  }
  const target: VerifyChallengeResult['target'] =
    row.identifierValue != null
      ? {
          identifier: {
            kind: row.identifierKind as IdentifierKind,
            value: row.identifierValue,
          },
          userId: null,
        }
      : { identifier: null, userId: row.userId };
  return {
    target,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
  };
}

export async function abortChallenge(
  db: NodePgDatabase,
  input: { challengeId: string },
): Promise<{ aborted: boolean }> {
  const challengeId = typeof input?.challengeId === 'string' ? input.challengeId : '';
  if (!isUuidLike(challengeId)) {
    return { aborted: false };
  }
  const rows = await db
    .update(identityChallenges)
    .set({ abortedAt: sql`now()` })
    .where(
      and(
        eq(identityChallenges.id, challengeId),
        isNull(identityChallenges.consumedAt),
        isNull(identityChallenges.abortedAt),
      ),
    )
    .returning({ id: identityChallenges.id });
  return { aborted: rows.length > 0 };
}
