import { Hono, type Context } from 'hono';
import { sourceIp } from '../middleware/auth-failure-guard.js';
import type { OAuthService } from '../services/auth/oauth-service.js';
import { HttpError } from '../lib/http.js';

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
export function oauthTokenRoutes(oauth: OAuthService, trustedProxyHops = 0): Hono {
  return new Hono().post('/', async (c) => {
    const ip = sourceIp(c, trustedProxyHops);
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
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        throw new HttpError('invalid_request', '请求体不是合法 JSON');
      }
      clientId = body.client_id as string;
      clientSecret = body.client_secret as string;
      grantType = body.grant_type as string;
    }

    // Basic Auth 兜底（body 未带凭证时）
    if (!clientId || !clientSecret) {
      const auth = c.req.header('authorization') ?? '';
      const m = /^Basic\s+(.+)$/i.exec(auth);
      if (m) {
        try {
          const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
          const idx = decoded.indexOf(':');
          if (idx <= 0) throw new Error('malformed basic credentials');
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
    // T4：长度上界在任何 DB/Redis 访问之前——未鉴权接口不得把兆级 client_id
    // 变成 Redis 键（oauth_attempts:{id}）与 PG 绑定参（内存放大）。
    if (clientId.length > 64 || clientSecret.length > 256) {
      return oauthError(c, 400, 'invalid_request', 'client_id 或 client_secret 超长');
    }

    const result = await oauth.issueToken(clientId, clientSecret, ip);
    if (!result.ok) {
      if (result.retryAfterSec !== undefined) {
        c.header('retry-after', String(result.retryAfterSec));
      }
      return oauthError(c, result.status, result.error, result.description);
    }
    return c.json({
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
    });
  });
}

/** OAuth2 错误响应（RFC 6749 格式） */
function oauthError(c: Context, status: number, error: string, description: string) {
  return c.json({ error, error_description: description }, status as 400);
}
