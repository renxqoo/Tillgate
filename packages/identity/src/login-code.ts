import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sha256Hex } from '@ai-gateway/http';

/**
 * 登录验证码挑战（client-api 强制邮箱验证 / admin-api 2FA 共用，单一实现）。
 *
 *   签发 = 冷却检查 + code 哈希落 Redis（5 分钟 TTL）→ challengeId
 *   验证 = 计次比对 → 成功一次性消费（防重放）；错 5 次即作废
 *
 * 防刷口径（与登录密码限流互补）：
 *   - 发送冷却 60s/主体：防邮件轰炸（密码爆破由 login-throttle 管）
 *   - 6 位码 + 5 次机会：单挑战猜中概率 5/1e6
 *   - namespace 隔离 admin/user，键空间不串
 */

export const LOGIN_CODE_TTL_S = 300;
export const LOGIN_CODE_MAX_TRIES = 5;
export const LOGIN_CODE_RESEND_COOLDOWN_S = 60;

export type LoginCodeNamespace = 'admin' | 'user';

export type LoginCodeVerifyResult =
  | { ok: true; subjectId: string; data?: Record<string, string> }
  | { ok: false; reason: 'CHALLENGE_INVALID' | 'CHALLENGE_EXHAUSTED' | 'CODE_INVALID' };

/** 同一主体冷却期内重复签发（路由层映射 429 CODE_RATE_LIMITED） */
export class LoginCodeCooldownError extends Error {
  constructor(cooldownSec: number) {
    super(`验证码发送过于频繁，请 ${cooldownSec} 秒后再试`);
    this.name = 'LoginCodeCooldownError';
  }
}

/**
 * 签发挑战（含 60s 发送冷却）。code 由调用方生成（6 位数字）并负责投递（邮件）；
 * 投递失败时调用方应删除 challenge 键（见 admin-auth/client-auth 用法）。
 */
export async function issueLoginCodeChallenge(
  redis: Redis,
  ns: LoginCodeNamespace,
  subjectId: string,
  code: string,
  /** 附加字段（注册场景暂存 email/密码哈希；验证成功时原样返回，只存字符串） */
  extra?: Record<string, string>,
): Promise<string> {
  const coolKey = `logincode:cool:${ns}:${subjectId}`;
  const sent = await redis.incr(coolKey);
  if (sent === 1) await redis.expire(coolKey, LOGIN_CODE_RESEND_COOLDOWN_S);
  if (sent > 1) throw new LoginCodeCooldownError(LOGIN_CODE_RESEND_COOLDOWN_S);

  const challengeId = randomUUID();
  const key = `logincode:${ns}:challenge:${challengeId}`;
  await redis.hset(key, { subjectId, codeHash: sha256Hex(code), tries: '0', ...extra });
  await redis.expire(key, LOGIN_CODE_TTL_S);
  return challengeId;
}

/** 签发后投递失败时的回滚（删冷却 + 挑战，让用户可立即重试） */
export async function abortLoginCodeChallenge(
  redis: Redis,
  ns: LoginCodeNamespace,
  subjectId: string,
  challengeId: string,
): Promise<void> {
  await redis
    .del(`logincode:cool:${ns}:${subjectId}`, `logincode:${ns}:challenge:${challengeId}`)
    .catch(() => {});
}

/**
 * 验证挑战。成功一次性消费；第 5 次错误即作废（此后正确码也 CHALLENGE_INVALID）。
 */
export async function verifyLoginCodeChallenge(
  redis: Redis,
  ns: LoginCodeNamespace,
  challengeId: string,
  code: string,
): Promise<LoginCodeVerifyResult> {
  const key = `logincode:${ns}:challenge:${challengeId}`;
  const stored = await redis.hgetall(key);
  if (!stored || !stored.subjectId || !stored.codeHash) {
    return { ok: false, reason: 'CHALLENGE_INVALID' };
  }
  const tries = await redis.hincrby(key, 'tries', 1);
  if (sha256Hex(code) === stored.codeHash) {
    await redis.del(key);
    const { subjectId, codeHash: _codeHash, tries: _tries, ...data } = stored;
    return { ok: true, subjectId, data: Object.keys(data).length > 0 ? data : undefined };
  }
  if (tries >= LOGIN_CODE_MAX_TRIES) {
    await redis.del(key);
    return { ok: false, reason: 'CHALLENGE_EXHAUSTED' };
  }
  return { ok: false, reason: 'CODE_INVALID' };
}
