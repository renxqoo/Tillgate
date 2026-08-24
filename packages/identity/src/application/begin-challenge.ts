/**
 * 发码:目标解析与通道 fail-closed → 锁内「冷却判定 + 替换 + INSERT」原子决策 →
 * 提交后投递(失败即作废,可立刻重发;补救 abort 失败记 warn,B11)。
 * 投递上下文(ip/locale)全程内存流动——v1 模块级 Map 串号/泄漏根治(B05)。
 */
import { advisoryLock, runTx } from '@tillgate/db';
import { auditEvent } from '../domain/audit-events.js';
import { challengeLockKey, challengeTargetKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import {
  channelFor,
  codeHashOf,
  newChallengeId,
  randomCode,
  serializePayload,
  boundedOverride,
  CHALLENGE_BOUNDS,
  type DeliveryChannel,
} from '../domain/challenge.js';
import {
  assertUserId,
  guardChallengeKind,
  normalizeIdentifier,
  type NormalizedIdentifier,
} from '../domain/identifier.js';
import type { ChallengeTarget } from '../domain/challenge.js';
import type { IdentityUseCaseContext } from './context.js';
import { recordAudit } from './context.js';

export interface BeginChallengeInput {
  readonly kind: string;
  readonly target: ChallengeTarget;
  readonly payload?: Record<string, unknown>;
  readonly overrides?: { ttlMs?: number; cooldownMs?: number; maxAttempts?: number };
  /** 投递上下文(随邮件展示;不落库,begin→deliver 同调用内存流动) */
  readonly delivery?: { ip: string; locale?: 'en' | 'zh' };
}

export interface BeginChallengeResult {
  readonly challengeId: string;
  readonly code: string;
  readonly expiresAt: string;
  readonly channel: DeliveryChannel;
  readonly to: string;
}

export async function beginChallenge(
  ctx: IdentityUseCaseContext,
  input: BeginChallengeInput,
): Promise<BeginChallengeResult> {
  const kind = guardChallengeKind(input.kind, ctx.guards);

  // 目标归一 + 投递寻址(email→email 通道;phone→sms 未实现 fail-closed;username 无通道)
  let identifier: NormalizedIdentifier | null = null;
  let userId: number | null = null;
  let channel: DeliveryChannel | null;
  let to: string;
  if (input.target != null && 'identifier' in input.target && input.target.identifier != null) {
    const norm = normalizeIdentifier(input.target.identifier, ctx.guards);
    channel = channelFor(norm.kind);
    if (channel == null) {
      throw identityErrors.business('undeliverable_challenge', {
        kind,
        detail: `identifier kind '${norm.kind}' has no delivery channel`,
      });
    }
    identifier = norm;
    to = norm.value;
  } else if (input.target != null && 'userId' in input.target) {
    userId = assertUserId(input.target.userId);
    // 用户目标寻址:email 优先、phone 次之(注册序无关,确定性排序)
    const cred = await ctx.credentialStore.findDeliveryIdentifier(ctx.db, userId);
    channel = cred ? channelFor(cred.kind) : null;
    if (cred == null || channel == null) {
      throw identityErrors.business('undeliverable_challenge', {
        kind,
        detail: `user ${userId} has no email/phone credential`,
      });
    }
    to = cred.value;
  } else {
    throw identityErrors.business('invalid_input', {
      field: 'target',
      reason: 'must be { identifier } or { userId }',
    });
  }
  if (channel === 'sms' || (channel === 'email' && ctx.mailer == null)) {
    // B12 修复:可投递通道无投递器 = 不建挑战直接拒绝(sms 通道未实现,W6)
    throw identityErrors.business('undeliverable_challenge', {
      kind,
      detail:
        channel === 'sms'
          ? 'sms delivery channel is not implemented'
          : 'email mailer is not assembled',
    });
  }

  const payload = serializePayload(input.payload);
  const ttlMs = boundedOverride(
    input.overrides?.ttlMs,
    ctx.config.challenge.ttlMs,
    'ttlMs',
    CHALLENGE_BOUNDS.ttlMs[0],
    CHALLENGE_BOUNDS.ttlMs[1],
  );
  const cooldownMs = boundedOverride(
    input.overrides?.cooldownMs,
    ctx.config.challenge.cooldownMs,
    'cooldownMs',
    CHALLENGE_BOUNDS.cooldownMs[0],
    CHALLENGE_BOUNDS.cooldownMs[1],
  );
  const maxAttempts = boundedOverride(
    input.overrides?.maxAttempts,
    ctx.config.challenge.maxAttempts,
    'maxAttempts',
    CHALLENGE_BOUNDS.maxAttempts[0],
    CHALLENGE_BOUNDS.maxAttempts[1],
  );

  const code = randomCode(ctx.config.challenge.digits);
  const challengeId = newChallengeId();
  const outcome = await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, challengeLockKey(kind, challengeTargetKey(identifier, userId)));
      return ctx.challengeStore.beginChallenge(tx, {
        challengeId,
        kind,
        identifier,
        userId,
        codeHash: codeHashOf(code, challengeId, ctx.config.codePepper),
        payload,
        ttlMs,
        cooldownMs,
        maxAttempts,
      });
    },
    ctx.txRetry,
  );
  if (outcome.status === 'cooldown') {
    throw identityErrors.business('challenge_cooldown', {
      kind,
      retryAfterMs: outcome.retryAfterMs,
    });
  }

  // 投递在提交后(deliver 不参与安全事实事务);失败立即作废挑战——
  // 用户侧语义:发不出去 = 流程没发生,可立刻重试(作废让出冷却位)
  try {
    await ctx.mailer!.sendLoginCode(to, code, {
      ip: input.delivery?.ip ?? '',
      ...(input.delivery?.locale != null ? { locale: input.delivery.locale } : {}),
    });
  } catch {
    try {
      await ctx.challengeStore.abortChallenge(ctx.db, { challengeId });
    } catch (error) {
      // B11 修复:补救作废失败不再静默——记 warn(挑战将占冷却位至 TTL,运维可查)
      ctx.logger.warn(
        { err: (error as Error).message, challengeId },
        'challenge abort-after-delivery-failure failed; cooldown slot held until TTL',
      );
    }
    throw identityErrors.business('delivery_failed', { kind, channel });
  }
  // 审计在投递成功后(事实=挑战已发到目标;投递失败路径已作废,不该有 begin 事件)——
  // 独立连接单写,失败抛错不吞(§5.4 不降级)
  await recordAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: 'system',
      action: 'challenge.begin',
      targetType: 'challenge',
      targetId: challengeId,
      detail: { kind, channel, to },
    }),
  );
  return { challengeId, code, expiresAt: outcome.expiresAt, channel, to };
}
