/**
 * POST /oauth/token —— App JWT 签发（client_credentials 流；凭证校验走 accounts
 * verifyAppClient，SQL 不进 app）。
 * 签发口径与验证口径逐字段配对：app_id = apps.app_id 字符串；
 * iss/aud 显式；scope 全量入令牌（rpm/tpm 限流 + models 白名单的执行依据）。
 * 爆破防护：IP 维 + client:{clientId} 维双锁（IP 可轮换，按 clientId 才能挡撞 secret）。
 * 失败 401 用 OAuth 标准错误形（invalid_client，非 OpenAI 信封）。
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

const oauthError = (c: Context, status: 400 | 401, body: { error: string; description: string }) =>
  c.json({ error: body.error, error_description: body.description }, status);

/** 凭证三形态提取（form / JSON；Basic 兜底另行解析） */
async function extractCredentials(
  c: Context,
): Promise<{ clientId?: string; clientSecret?: string; grantType?: string }> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = await c.req.parseBody();
    return {
      clientId: form.client_id as string,
      clientSecret: form.client_secret as string,
      grantType: form.grant_type as string,
    };
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    clientId: body.client_id as string,
    clientSecret: body.client_secret as string,
    grantType: body.grant_type as string,
  };
}

/** Basic Auth 兜底解析（form/JSON 缺凭证时用；解码失败或无 ':' 分隔即静默回退空） */
function basicAuthCredentials(authHeader: string): { clientId?: string; clientSecret?: string } {
  const encoded = /^Basic\s+(.+)$/i.exec(authHeader)?.[1];
  if (encoded == null) return {};
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx > 0) {
      return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** App JWT 签发（scope 全量入令牌：rpm/tpm 限流 + models 白名单的执行依据） */
async function signAppJwt(
  deps: OAuthTokenDeps,
  app: { userId: number; appId: string; scope: object | null },
): Promise<string> {
  const secret = new TextEncoder().encode(deps.jwtSecret);
  return new SignJWT({
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
}

/** 爆破失败双维记录（ip + client 维；守卫未装配即 no-op） */
async function recordGuardFailures(deps: OAuthTokenDeps, ip: string, guardKey: string) {
  if (deps.ipGuard) {
    await deps.ipGuard.recordFailure(ip).catch(() => {});
    await deps.ipGuard.recordFailure(guardKey).catch(() => {});
  }
}

/** 客户端 IP（按装配的 trustedProxyHops 口径） */
function clientIpOf(deps: OAuthTokenDeps, c: Context): string {
  return trustedClientIp({
    headers: c.req.raw.headers,
    trustedProxyHops: deps.trustedProxyHops,
    socketAddress: socketAddressFromContext(c),
  });
}

/** clientId 线格式：app_ + 16 hex（accounts 域生成口径）——守卫键入参先过形状闸 */
const CLIENT_ID_RE = /^app_[0-9a-f]{16}$/;

/**
 * 爆破锁 + 凭证校验（S7 语义）：
 * - IP 维锁 = 快速 401（不进凭证验证——攻击者 IP 不消耗验证成本）；
 * - 仅 client 维锁时仍验证——合法持有人以正确 secret 解锁（recordSuccess），
 *   不被他人撞锁连坐到 TTL 自然过期（否则持有人永远无法证明自己）。
 */
async function authenticateAgainstGuards(
  deps: OAuthTokenDeps,
  args: { ip: string; clientId: string; clientSecret: string },
): Promise<
  | { ok: true; app: NonNullable<Awaited<ReturnType<OAuthTokenDeps['verifyAppClient']>>> }
  | { ok: false; description: string }
> {
  const guardKey = `client:${args.clientId}`;
  const ipLocked = deps.ipGuard != null && (await deps.ipGuard.isLocked(args.ip)).locked;
  if (ipLocked) return { ok: false, description: 'source locked, try again later' };
  const clientLocked = deps.ipGuard != null && (await deps.ipGuard.isLocked(guardKey)).locked;
  const app = await deps.verifyAppClient({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
  });
  if (app == null) {
    await recordGuardFailures(deps, args.ip, guardKey);
    return {
      ok: false,
      description: clientLocked
        ? 'source locked, try again later'
        : 'invalid credentials or application disabled',
    };
  }
  if (clientLocked && deps.ipGuard != null) {
    const unlock = deps.ipGuard.recordSuccess?.(guardKey);
    if (unlock != null) await unlock.catch(() => {});
  }
  return { ok: true, app };
}

export function oauthTokenRoutes(deps: OAuthTokenDeps): Hono {
  return new Hono().post('/', async (c) => {
    const ip = clientIpOf(deps, c);
    // 支持 form / JSON / Basic Auth 三种凭证传递；Basic 兜底仅在 form/JSON 缺凭证时整体改用
    const creds = await extractCredentials(c);
    const { grantType } = creds;
    const fromBasic =
      !creds.clientId || !creds.clientSecret
        ? basicAuthCredentials(c.req.header('authorization') ?? '')
        : {};
    const clientId = fromBasic.clientId ?? creds.clientId;
    const clientSecret = fromBasic.clientSecret ?? creds.clientSecret;
    if (grantType !== 'client_credentials') {
      return oauthError(c, 400, {
        error: 'unsupported_grant_type',
        description: 'only client_credentials is supported',
      });
    }
    if (!clientId || !clientSecret) {
      return oauthError(c, 401, {
        error: 'invalid_client',
        description: 'missing client_id / client_secret',
      });
    }
    // 形状闸（S7）：非线格式 clientId 直接 401——任意串不得进守卫键空间
    // （每个失败请求写 2 个 Redis 键的可污染面收敛为零）
    if (!CLIENT_ID_RE.test(clientId)) {
      return oauthError(c, 401, {
        error: 'invalid_client',
        description: 'invalid client_id format',
      });
    }

    const auth = await authenticateAgainstGuards(deps, { ip, clientId, clientSecret });
    if (!auth.ok) {
      return oauthError(c, 401, { error: 'invalid_client', description: auth.description });
    }
    const { app } = auth;

    // app_id = apps.app_id（与鉴权端 resolveApp(appId) 同键配对）
    const token = await signAppJwt(deps, app);
    return c.json({ access_token: token, token_type: 'Bearer', expires_in: deps.tokenTtlSeconds });
  });
}
