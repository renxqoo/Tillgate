import { and, eq, isNull } from 'drizzle-orm';
import { apps, rateCardCoefficients } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Logger } from '@ai-gateway/core';
import { signJwt } from './jwt.js';

/** 常量时间比较两个 hex 字符串（防计时攻击），长度不同直接 false（不泄漏） */
function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 爆破防护阈值（默认 10 次失败/分钟 → 锁定 10 分钟） */
const OAUTH_MAX_ATTEMPTS = 10;
const OAUTH_LOCKOUT_TTL = 600;

export const OAUTH_TOKEN_TTL_SECONDS = 7200;

export type OAuthResult =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; status: number; error: string; description: string; retryAfterSec?: number };

/**
 * OAuth2 client_credentials 换 Token 服务（requirements 4.2）。
 *
 * 安全：
 *   - client_secret 用常量时间比较（防计时攻击逐字节恢复 hash）
 *   - App 不存在时也对假 hash 比较（保持响应时间一致，防用户名枚举）
 *   - G3 修复：爆破计数 key 只按 clientId（不混入 IP）——X-Forwarded-For 可伪造，
 *     混入 IP 会让攻击者每请求换伪造 IP 绕过锁定
 *   - 签发 JWT：sub=userId、appId、scope、coefficient 快照、exp=7200s
 */
export class OAuthService {
  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly jwtSecret: string,
    private readonly logger?: Logger,
  ) {}

  async issueToken(clientId: string, clientSecret: string, ip: string): Promise<OAuthResult> {
    // 爆破防护：检查是否已锁定
    const attemptKey = `oauth_attempts:${clientId}`;
    const attempts = parseInt((await this.redis.get(attemptKey)) ?? '0', 10);
    if (attempts >= OAUTH_MAX_ATTEMPTS) {
      const ttl = await this.redis.ttl(attemptKey);
      return {
        ok: false,
        status: 429,
        error: 'rate_limit_exceeded',
        description: `认证失败次数过多，请 ${Math.max(1, ttl)} 秒后重试`,
        retryAfterSec: Math.max(1, ttl),
      };
    }

    const app = await this.db.query.apps.findFirst({
      where: eq(apps.clientId, clientId),
      with: { user: true },
    });
    const secretHash = createHash('sha256').update(clientSecret).digest('hex');

    // 常量时间比较 clientSecretHash（防计时攻击）；App 不存在也对假 hash 比较（防用户名枚举）
    const expectedHash =
      app?.clientSecretHash ?? createHash('sha256').update('nonexistent-app-dummy').digest('hex');
    const secretMatch = safeEqualHex(secretHash, expectedHash);
    if (!app || !secretMatch) {
      // 失败计数（INCR + TTL，首次设过期）
      const newAttempts = await this.redis.incr(attemptKey);
      if (newAttempts === 1) await this.redis.expire(attemptKey, OAUTH_LOCKOUT_TTL);
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        description: 'client_id 或 client_secret 错误',
      };
    }
    if (app.status !== 0) {
      return { ok: false, status: 401, error: 'invalid_client', description: '应用已禁用' };
    }
    if (app.user.status !== 0) {
      return { ok: false, status: 401, error: 'invalid_client', description: '账户已被禁用' };
    }

    // 认证成功：清零失败计数
    await this.redis.del(attemptKey);

    // 费率卡系数快照（JWT 内）
    let coefficient = 1.0;
    if (app.user.rateCardId) {
      const coeff = await this.db.query.rateCardCoefficients.findFirst({
        where: and(
          eq(rateCardCoefficients.rateCardId, app.user.rateCardId),
          eq(rateCardCoefficients.scope, 'global'),
          isNull(rateCardCoefficients.modelMappingId),
        ),
      });
      if (coeff) coefficient = Number(coeff.coefficient);
    }

    const token = await signJwt(
      {
        userId: app.userId,
        appId: app.id,
        scope: app.scope ?? undefined,
        coefficient,
        expiresInSeconds: OAUTH_TOKEN_TTL_SECONDS,
      },
      this.jwtSecret,
    );

    this.logger?.info({ clientId, appId: app.id, userId: app.userId, ip }, 'oauth token issued');
    return { ok: true, accessToken: token, expiresIn: OAUTH_TOKEN_TTL_SECONDS };
  }
}
