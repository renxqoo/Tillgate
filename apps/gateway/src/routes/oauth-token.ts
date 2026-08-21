/**
 * POST /oauth/token —— App JWT 签发（client_credentials 流）。
 * apps 表 client_id + client_secret（SHA-256 比对）→ JWT（jose HS256，1h 有效）。
 * 后续推理请求以 Bearer <jwt> 鉴权（api-key 中间件 app_jwt 分支）。
 *
 * 签发口径必须与验证口径逐字段对齐（app_id = apps 数字主键、iss/aud 显式）——
 * 验证端按数字主键 + iss/aud 校验，任一端漂移都会令签出的令牌 100% 鉴权失败。
 * 爆破防护：复用鉴权层 ipGuard（失败计数 → 来源锁定，fail-closed）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { Db } from '@ai-gateway/repository';
import { apps } from '@ai-gateway/db';
import { socketAddressFromContext, trustedClientIp } from '@ai-gateway/http';
import type { AuthFailureGuard } from '@ai-gateway/core';

export interface OAuthTokenDeps {
  db: Db;
  jwtSecret: string;
  /** JWT 有效期（秒） */
  tokenTtlSeconds: number;
  /** 爆破防护（装配注入；未装配 = 单副本开发形态） */
  ipGuard?: AuthFailureGuard;
  /** 可信代理跳数（来源 IP 提取语义） */
  trustedProxyHops?: number;
}

const JWT_ISSUER = 'ai-gateway';
const JWT_AUDIENCE = 'ai-gateway-api';

export function oauthTokenRoutes(deps: OAuthTokenDeps): Hono {
  const sourceIp = (c: Context): string =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: deps.trustedProxyHops ?? 0,
      socketAddress: socketAddressFromContext(c),
    });
  return new Hono().post('/', async (c) => {
    const ip = sourceIp(c);
    const fail = async (guardKey: string) => {
      if (deps.ipGuard) {
        await deps.ipGuard.recordFailure(ip).catch(() => undefined);
        await deps.ipGuard.recordFailure(guardKey).catch(() => undefined);
      }
      return c.json({ error: 'invalid_client', error_description: 'invalid credentials or application disabled' }, 401);
    };
    // 支持 form / JSON / Basic Auth 三种凭证传递
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
    if (!clientId || !clientSecret) {
      const auth = c.req.header('authorization') ?? '';
      const basic = /^Basic\s+(.+)$/i.exec(auth);
      if (basic) {
        try {
          const decoded = Buffer.from(basic[1]!, 'base64').toString('utf-8');
          const idx = decoded.indexOf(':');
          if (idx > 0) {
            clientId = decoded.slice(0, idx);
            clientSecret = decoded.slice(idx + 1);
          }
        } catch { /* fall through */ }
      }
    }
    if (grantType !== 'client_credentials') {
      return c.json({ error: 'unsupported_grant_type', error_description: 'only client_credentials is supported' }, 400);
    }
    if (!clientId || !clientSecret) {
      return c.json({ error: 'invalid_client', error_description: 'missing client_id / client_secret' }, 401);
    }

    // per-clientId 爆破锁：IP 可轮换——按 clientId 锁定才能挡住撞 client_secret
    const guardKey = `client:${clientId}`;
    if (deps.ipGuard) {
      const [ipLock, keyLock] = await Promise.all([
        deps.ipGuard.isLocked(ip),
        deps.ipGuard.isLocked(guardKey),
      ]);
      if (ipLock.locked || keyLock.locked) {
        return c.json({ error: 'invalid_client', error_description: 'source locked, try again later' }, 401);
      }
    }

    const secretHash = createHash('sha256').update(clientSecret).digest('hex');
    const [app] = await deps.db
      .select({ id: apps.id, userId: apps.userId, status: apps.status, scope: apps.scope })
      .from(apps)
      .where(and(eq(apps.clientId, clientId), eq(apps.clientSecretHash, secretHash)));
    if (!app || app.status !== 0) {
      return fail(guardKey);
    }

    const secret = new TextEncoder().encode(deps.jwtSecret);
    // app_id = apps.id（数字主键的字符串形——验证端 findActiveAppById 的查询键）
    // scope 全量入令牌（rpm/tpm 限流 + models 白名单——网关准入与模型列表过滤的执行依据）
    const token = await new SignJWT({
      sub: String(app.userId),
      app_id: app.id,
      typ: 'app_jwt',
      ...(app.scope && typeof app.scope === 'object' ? { scope: app.scope } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime(`${deps.tokenTtlSeconds}s`)
      .sign(secret);

    return c.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: deps.tokenTtlSeconds,
    });
  });
}
