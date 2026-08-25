/**
 * 发码:目标解析与通道 fail-closed → 锁内「冷却判定 + 替换 + INSERT」原子决策 →
 * 提交后投递(失败即作废,可立刻重发;补救 abort 失败记 warn,B11)。
 * 投递上下文(ip/locale)全程内存流动——v1 模块级 Map 串号/泄漏根治(B05)。
 */
import { advisoryLock, runTx } from '@tillgate/db';
import { isBusinessError } from '@tillgate/errors';
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
  /** 投递上下文(随邮件展示/定文案;不落库,begin→deliver 同调用内存流动) */
  readonly delivery?: {
    ip: string;
    locale?: 'en' | 'zh';
    /** 邮件用途文案:login 缺省;two_factor_toggle=管理端 2FA 开关确认 */
    purpose?: 'login' | 'two_factor_toggle';
  };
}

export interface BeginChallengeResult {
  readonly challengeId: string;
  readonly code: string;
  readonly expiresAt: string;
  readonly channel: DeliveryChannel;
  readonly to: string;
}

/** 目标解析产物:归一后的标识/用户 + 投递通道与收件地址 */
interface ResolvedDelivery {
  readonly identifier: NormalizedIdentifier | null;
  readonly userId: number | null;
  readonly channel: DeliveryChannel;
  readonly to: string;
}

/** 目标归一 + 投递寻址(email→email 通道;phone→sms 未实现 fail-closed;username 无通道) */
async function resolveDeliveryTarget(
  ctx: IdentityUseCaseContext,
  input: BeginChallengeInput,
  kind: string,
): Promise<ResolvedDelivery> {
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
  return { identifier, userId, channel, to };
}

/** 参数解析:payload 序列化 + 三参数有界覆盖(缺省来自配置,边界来自域常量) */
function resolveChallengeBounds(
  ctx: IdentityUseCaseContext,
  input: BeginChallengeInput,
): {
  payload: Record<string, unknown> | null;
  ttlMs: number;
  cooldownMs: number;
  maxAttempts: number;
} {
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
  return { payload, ttlMs, cooldownMs, maxAttempts };
}

/** 锁内发码(advisoryLock + 冷却判定/替换/INSERT 原子决策);冷却即拒绝 */
async function insertChallengeWithinLock(
  ctx: IdentityUseCaseContext,
  input: {
    kind: string;
    challengeId: string;
    code: string;
    identifier: NormalizedIdentifier | null;
    userId: number | null;
    payload: Record<string, unknown> | null;
    ttlMs: number;
    cooldownMs: number;
    maxAttempts: number;
  },
): Promise<{ expiresAt: string }> {
  const outcome = await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(
        tx,
        challengeLockKey(input.kind, challengeTargetKey(input.identifier, input.userId)),
      );
      return ctx.challengeStore.beginChallenge(tx, {
        challengeId: input.challengeId,
        kind: input.kind,
        identifier: input.identifier,
        userId: input.userId,
        codeHash: codeHashOf(input.code, input.challengeId, ctx.config.codePepper),
        payload: input.payload,
        ttlMs: input.ttlMs,
        cooldownMs: input.cooldownMs,
        maxAttempts: input.maxAttempts,
      });
    },
    ctx.txRetry,
  );
  if (outcome.status === 'cooldown') {
    throw identityErrors.business('challenge_cooldown', {
      kind: input.kind,
      retryAfterMs: outcome.retryAfterMs,
    });
  }
  return { expiresAt: outcome.expiresAt };
}

/** 投递(提交后,不参与安全事实事务):失败立即作废挑战——用户侧可立刻重试(作废让出冷却位) */
async function deliverLoginCode(
  ctx: IdentityUseCaseContext,
  args: {
    kind: string;
    channel: DeliveryChannel;
    to: string;
    challengeId: string;
    code: string;
    delivery: BeginChallengeInput['delivery'];
  },
): Promise<void> {
  const { mailer } = ctx;
  if (mailer == null) {
    // 可投递性已在 resolveDeliveryTarget 处校验,此处兜底 fail-closed
    throw identityErrors.business('undeliverable_challenge', {
      kind: args.kind,
      detail: 'email mailer is not assembled',
    });
  }
  try {
    await mailer.sendLoginCode(args.to, args.code, {
      ip: args.delivery?.ip ?? '',
      ...(args.delivery?.locale != null ? { locale: args.delivery.locale } : {}),
      ...(args.delivery?.purpose != null ? { purpose: args.delivery.purpose } : {}),
    });
  } catch (error) {
    try {
      await ctx.challengeStore.abortChallenge(ctx.db, { challengeId: args.challengeId });
    } catch (abortError) {
      // B11 修复:补救作废失败不再静默——记 warn(挑战将占冷却位至 TTL,运维可查)
      ctx.logger.warn(
        { err: (abortError as Error).message, challengeId: args.challengeId },
        'challenge abort-after-delivery-failure failed; cooldown slot held until TTL',
      );
    }
    // mailer 抛出的业务错误原样透传(undeliverable_challenge = fail-closed「未配置」
    // 信号,unavailable 类别出网 503)——裸吞改码成 delivery_failed 会把「未配置」
    // 漂移成「渠道坏流 502」(wire 契约分级,动态 mailer 路径回归)
    if (isBusinessError(error)) throw error;
    throw identityErrors.business('delivery_failed', { kind: args.kind, channel: args.channel });
  }
}

/** 审计在投递成功后(事实=挑战已发到目标;投递失败路径已作废,不该有 begin 事件)——独立连接单写,失败抛错不吞(§5.4 不降级) */
async function recordBeginAudit(
  ctx: IdentityUseCaseContext,
  args: { kind: string; channel: DeliveryChannel; to: string; challengeId: string },
): Promise<void> {
  await recordAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: 'system',
      action: 'challenge.begin',
      targetType: 'challenge',
      targetId: args.challengeId,
      detail: { kind: args.kind, channel: args.channel, to: args.to },
    }),
  );
}

export async function beginChallenge(
  ctx: IdentityUseCaseContext,
  input: BeginChallengeInput,
): Promise<BeginChallengeResult> {
  const kind = guardChallengeKind(input.kind, ctx.guards);
  const target = await resolveDeliveryTarget(ctx, input, kind);
  const bounds = resolveChallengeBounds(ctx, input);
  const code = randomCode(ctx.config.challenge.digits);
  const challengeId = newChallengeId();
  const { expiresAt } = await insertChallengeWithinLock(ctx, {
    kind,
    challengeId,
    code,
    identifier: target.identifier,
    userId: target.userId,
    ...bounds,
  });
  await deliverLoginCode(ctx, {
    kind,
    channel: target.channel,
    to: target.to,
    challengeId,
    code,
    delivery: input.delivery,
  });
  await recordBeginAudit(ctx, { kind, channel: target.channel, to: target.to, challengeId });
  return { challengeId, code, expiresAt, channel: target.channel, to: target.to };
}
