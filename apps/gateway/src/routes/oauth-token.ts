import { Hono, type Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { apps, rateCardCoefficients } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { createHash, timingSafeEqual } from 'node:crypto';
import { signJwt } from '../lib/jwt.js';
import { env, logger } from '../index.js';

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

/**
 * POST /oauth/token — 企业 Agent 换 Token（OAuth2 client_credentials）
 *
 * 认证方式（二选一）：
 *   - body 传参：grant_type=client_credentials & client_id & client_secret
 *   - Basic Auth：Authorization: Basic base64(client_id:client_secret)
 *
 * 成功 → { access_token, token_type: "Bearer", expires_in: 7200 }
 * 失败 → 400 invalid_request / 401 invalid_client
 */
export function oauthTokenRoutes(db: Db, redis: Redis): Hono {
  return new Hono().post('/', async (c) => {
    // 爆破防护：检查 client_id+IP 是否被锁定
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    let grantType: string | undefined;

    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await c.req.parseBody();
      clientId = form.client_id as string;
      clientSecret = form.client_secret as string;
      grantType = form.grant_type as string;
    } else {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      clientId = body.client_id as string;
      clientSecret = body.client_secret as string;
      grantType = body.grant_type as string;
    }

    // Basic Auth 兜底
    if (!clientId || !clientSecret) {
      const auth = c.req.header('authorization') ?? '';
      const m = /^Basic\s+(.+)$/i.exec(auth);
      if (m) {
        try {
          const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
          const idx = decoded.indexOf(':');
          clientId = clientId || decoded.slice(0, idx);
          clientSecret = clientSecret || decoded.slice(idx + 1);
        } catch {
          /* 格式错误，下面校验会失败 */
        }
      }
    }

    if (grantType !== 'client_credentials') {
      return oauthError(c, 400, 'invalid_request', 'grant_type 必须为 client_credentials');
    }
    if (!clientId || !clientSecret) {
      return oauthError(c, 400, 'invalid_request', '缺少 client_id 或 client_secret');
    }

    // 爆破防护：检查是否已锁定。
    // G3 修复：计数 key 只按 clientId（不混入 IP）——X-Forwarded-For 客户端可伪造，
    // 混入 IP 会让攻击者每请求换伪造 IP 绕过锁定。与 gateway 静态 Key 的 brute-force-guard
    // （按 keyHash 维度，不依赖 IP）保持一致。ip 仅用于日志/排障。
    const attemptKey = `oauth_attempts:${clientId}`;
    const attempts = parseInt((await redis.get(attemptKey)) ?? '0', 10);
    if (attempts >= OAUTH_MAX_ATTEMPTS) {
      const ttl = await redis.ttl(attemptKey);
      return oauthError(c, 429, 'rate_limit_exceeded', `认证失败次数过多，请 ${Math.max(1, ttl)} 秒后重试`);
    }

    const app = await db.query.apps.findFirst({
      where: eq(apps.clientId, clientId),
      with: { user: true },
    });
    const secretHash = createHash('sha256').update(clientSecret).digest('hex');

    // #4 修复：常量时间比较 clientSecretHash（防计时攻击逐字节恢复 hash）
    // 即使 app 不存在也对假 hash 做一次比较（保持响应时间一致，防用户名枚举）
    const expectedHash = app?.clientSecretHash ?? createHash('sha256').update('nonexistent-app-dummy').digest('hex');
    const secretMatch = safeEqualHex(secretHash, expectedHash);
    if (!app || !secretMatch) {
      // 失败计数（INCR + TTL，首次设过期）
      const newAttempts = await redis.incr(attemptKey);
      if (newAttempts === 1) await redis.expire(attemptKey, OAUTH_LOCKOUT_TTL);
      return oauthError(c, 401, 'invalid_client', 'client_id 或 client_secret 错误');
    }
    if (app.status !== 0) {
      return oauthError(c, 401, 'invalid_client', '应用已禁用');
    }
    if (app.user.status !== 0) {
      return oauthError(c, 401, 'invalid_client', '账户已被禁用');
    }

    // 认证成功：清零失败计数
    await redis.del(attemptKey);

    // 费率卡系数快照（JWT 内）
    let coefficient = 1.0;
    if (app.user.rateCardId) {
      const coeff = await db.query.rateCardCoefficients.findFirst({
        where: and(
          eq(rateCardCoefficients.rateCardId, app.user.rateCardId),
          eq(rateCardCoefficients.scope, 'global'),
          isNull(rateCardCoefficients.modelMappingId),
        ),
      });
      if (coeff) coefficient = Number(coeff.coefficient);
    }

    const expiresInSeconds = 7200;
    const token = await signJwt(
      { userId: app.userId, appId: app.id, scope: app.scope ?? undefined, coefficient, expiresInSeconds },
      env.JWT_SECRET,
    );

    logger.info({ clientId, appId: app.id, userId: app.userId, ip }, 'oauth token issued');
    return c.json({ access_token: token, token_type: 'Bearer', expires_in: expiresInSeconds });
  });
}

/** OAuth2 错误响应（RFC 6749 格式） */
function oauthError(c: Context, status: number, error: string, description: string) {
  return c.json({ error, error_description: description }, status as 400);
}
