/**
 * POST /oauth/token —— App JWT 签发（client_credentials 流；v1 oauth-token.ts 迁移，
 * A1 修复：凭证校验走 accounts verifyAppClient，SQL 不进 app）。
 * 签发口径与验证口径逐字段配对：app_id = apps.app_id 字符串（R-E2，v1 为数字主键）；
 * iss/aud 显式；scope 全量入令牌（rpm/tpm 限流 + models 白名单的执行依据）。
 * 爆破防护：IP 维 + client:{clientId} 维双锁（IP 可轮换，按 clientId 才能挡撞 secret）。
 * 失败 401 用 OAuth 标准错误形（invalid_client，非 OpenAI 信封——A9）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { SignJWT } from 'jose';
import type { AuthFailureGuard } from '@tillgate/runtime';
import { socketAddressFromContext, trustedClientIp } from '@tillgate/http';

export interface OAuthTokenDeps {
  /** apps 凭证校验（accounts facade 绑定；status=0 + 属主守卫在读模型内） */
  verifyAppClient(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<{ id: number; appId: string; userId: number; scope: object | null } | null>;
  jwtSecret: string;
  /** JWT 有效期（秒） */
  tokenTtlSeconds: number;
  issuer: string;
  audience: string;
  /** 爆破防护（装配注入；未装配 = 单副本开发形态） */
  ipGuard?: AuthFailureGuard;
  trustedProxyHops: number;
}

const oauthError = (c: Context, status: 400 | 401, error: string, description: string) =>
  c.json({ error, error_description: description }, status);

export function oauthTokenRoutes(deps: OAuthTokenDeps): Hono {
  const sourceIp = (c: Context): string =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: deps.trustedProxyHops,
      socketAddress: socketAddressFromContext(c),
    });
  return new Hono().post('/', async (c) => {
    const ip = sourceIp(c);
    const fail = async (guardKey: string) => {
      if (deps.ipGuard) {
        await deps.ipGuard.recordFailure(ip).catch(() => undefined);
        await deps.ipGuard.recordFailure(guardKey).catch(() => undefined);
      }
      return oauthError(c, 401, 'invalid_client', 'invalid credentials or application disabled');
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
        } catch {
          /* fall through */
        }
      }
    }
    if (grantType !== 'client_credentials') {
      return oauthError(c, 400, 'unsupported_grant_type', 'only client_credentials is supported');
    }
    if (!clientId || !clientSecret) {
      return oauthError(c, 401, 'invalid_client', 'missing client_id / client_secret');
    }

    // per-clientId 爆破锁：IP 可轮换——按 clientId 锁定才能挡住撞 client_secret
    const guardKey = `client:${clientId}`;
    if (deps.ipGuard) {
      const [ipLock, keyLock] = await Promise.all([
        deps.ipGuard.isLocked(ip),
        deps.ipGuard.isLocked(guardKey),
      ]);
      if (ipLock.locked || keyLock.locked) {
        return oauthError(c, 401, 'invalid_client', 'source locked, try again later');
      }
    }

    const app = await deps.verifyAppClient({ clientId, clientSecret });
    if (!app) return fail(guardKey);

    const secret = new TextEncoder().encode(deps.jwtSecret);
    // app_id = apps.app_id（R-E2：与鉴权端 resolveApp(appId) 同键配对）
    // scope 全量入令牌（rpm/tpm 限流 + models 白名单——网关准入与模型列表过滤的执行依据）
    const token = await new SignJWT({
      sub: String(app.userId),
      app_id: app.appId,
      typ: 'app_jwt',
      ...(app.scope != null && typeof app.scope === 'object' ? { scope: app.scope } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(deps.issuer)
      .setAudience(deps.audience)
      .setExpirationTime(`${deps.tokenTtlSeconds}s`)
      .sign(secret);

    return c.json({ access_token: token, token_type: 'Bearer', expires_in: deps.tokenTtlSeconds });
  });
}
