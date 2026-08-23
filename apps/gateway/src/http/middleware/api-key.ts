/**
 * API Key 鉴权中间件（v1 middleware/api-key.ts 语义迁移；A1/A8 在案）：
 *   Bearer ag_xxx → SHA-256 → accounts resolveKeyByHash（status/过期/属主守卫在
 *   accounts 读模型，每调用直查无缓存）；Bearer <jwt> → jose HS256 验签（算法白名单
 *   + iss/aud，仅认 typ=app_jwt + app_id + sub）→ accounts resolveApp 双 status 守卫。
 * App-JWT 解析键 = apps.app_id（R-E2：v1 数字主键 → v2 应用标识串，签发端同键配对）。
 *
 * 爆破防护（runtime guards 注入；未装配 = 单副本开发形态跳过）：
 *   Key 分支 keyHash 维 + IP 维双计；JWT 分支只计 IP 维（Key 可枚举、JWT 不可——A8）。
 * 真实 socket 对端地址缺失时 trustedClientIp 落进程级常量（全部客户端共享 IP 桶）——
 * 生产必须注入；app.request 测试无连接信息是唯一合法 null 形态。
 */
import { createHash, randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { socketAddressFromContext, trustedClientIp, HttpErrors } from '@tokenlens/http';
import type { AuthFailureGuard, KeyBruteForceGuard } from '@tokenlens/runtime';

export interface AuthContext {
  userId: number;
  /** 静态 Key 凭证（JWT 凭证为 null——限流维度退到 user） */
  apiKeyId: number | null;
  /** App JWT 凭证（静态 Key 为 null） */
  appId: number | null;
  /** 模型白名单（App JWT scope.models；null = 不限——准入与 /v1/models 过滤的单一真相） */
  allowedModels: readonly string[] | null;
  /** 凭证级限流（null = 不限；限流闸消费） */
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 用户级限流（与凭证级并罚，不互相覆盖） */
  userRpmLimit: number | null;
  userTpmLimit: number | null;
}

export interface AuthEnv {
  Variables: {
    auth: AuthContext;
    requestId: string;
  };
}

export interface AuthGuards {
  keyGuard: KeyBruteForceGuard;
  ipGuard: AuthFailureGuard;
  /** 可信代理跳数（来源 IP 提取语义） */
  trustedProxyHops: number;
}

/** 鉴权读模型（accounts facade 绑定面；SQL/守卫在 accounts 侧） */
export interface AuthReadModel {
  resolveKeyByHash(keyHash: string): Promise<{
    keyId: number;
    userId: number;
    rpmLimit: number | null;
    tpmLimit: number | null;
    allowPaygFallback: boolean;
    userRpmLimit: number | null;
    userTpmLimit: number | null;
  } | null>;
  resolveApp(appId: string): Promise<{
    id: number;
    userId: number;
    scope: { rpm?: number; tpm?: number; models?: readonly string[] } | null;
  } | null>;
}

/** 限额有效性（0/null = 不限维） */
function positive(v: number | null | undefined): number | null {
  return v != null && v > 0 ? v : null;
}

/** JWT 凭证载荷（/oauth/token 签发的 app_jwt 形态） */
interface GatewayJwtPayload {
  typ?: string;
  sub?: string;
  app_id?: string;
  scope?: { rpm?: number; tpm?: number; models?: string[] };
}

export function apiKeyMiddleware(
  reader: AuthReadModel,
  guards: AuthGuards | undefined,
  jwt: { secret: string; issuer: string; audience: string; keyPrefix: string },
): MiddlewareHandler<AuthEnv> {
  const sourceIpOf = (c: Parameters<MiddlewareHandler<AuthEnv>>[0]): string =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: guards?.trustedProxyHops ?? 0,
      socketAddress: socketAddressFromContext(c),
    });

  const verifyJwt = async (token: string): Promise<GatewayJwtPayload> => {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwt.secret), {
      issuer: jwt.issuer,
      audience: jwt.audience,
      algorithms: ['HS256'], // 算法族白名单（防混淆攻击）
    }).catch(() => {
      throw HttpErrors.business('unauthorized', { detail: 'invalid or expired jwt credential' });
    });
    return payload as unknown as GatewayJwtPayload;
  };

  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    // ---- JWT 凭证分支：伪造 JWT 狂刷 401 不计失败 = 未认证无限打点；per-IP 锁前置 ----
    if (!token.startsWith(jwt.keyPrefix)) {
      if (!token) throw HttpErrors.business('unauthorized', { detail: 'missing or malformed api key' });
      if (guards) {
        const ipLock = await guards.ipGuard.isLocked(sourceIpOf(c));
        if (ipLock.locked) {
          throw HttpErrors.business('unauthorized', { detail: `source locked, retry after ${ipLock.retryAfterSec}s` });
        }
      }
      try {
        const payload = await verifyJwt(token);
        // 仅支持 app_jwt：操练场（playground）等其他形态一律 401——信任根分离
        if (payload.typ !== 'app_jwt' || payload.app_id == null || payload.sub == null) {
          throw HttpErrors.business('unauthorized', { detail: 'unsupported jwt credential type' });
        }
        const app = await reader.resolveApp(payload.app_id);
        if (!app || app.userId !== Number(payload.sub)) {
          throw HttpErrors.business('unauthorized', { detail: 'app credential inactive' });
        }
        c.set('auth', {
          userId: app.userId,
          apiKeyId: null,
          appId: app.id,
          allowedModels:
            app.scope?.models != null && app.scope.models.length > 0
              ? [...app.scope.models]
              : null,
          rpmLimit: positive(app.scope?.rpm),
          tpmLimit: positive(app.scope?.tpm),
          userRpmLimit: null,
          userTpmLimit: null,
        });
        await next();
        return;
      } catch (error) {
        if (guards && error instanceof Error && (error as { code?: string }).code === HttpErrors.code('unauthorized')) {
          await guards.ipGuard.recordFailure(sourceIpOf(c));
        }
        throw error;
      }
    }

    const keyHash = createHash('sha256').update(token).digest('hex');

    if (guards) {
      const keyLock = await guards.keyGuard.isLocked(keyHash);
      if (keyLock.locked) {
        throw HttpErrors.business('unauthorized', { detail: `api key locked, retry after ${keyLock.retryAfterSec}s` });
      }
      const ipLock = await guards.ipGuard.isLocked(sourceIpOf(c));
      if (ipLock.locked) {
        throw HttpErrors.business('unauthorized', { detail: `source locked, retry after ${ipLock.retryAfterSec}s` });
      }
    }

    const key = await reader.resolveKeyByHash(keyHash);
    if (!key) {
      if (guards) {
        await guards.keyGuard.recordFailure(keyHash);
        await guards.ipGuard.recordFailure(sourceIpOf(c));
      }
      throw HttpErrors.business('unauthorized');
    }
    if (guards) await guards.keyGuard.recordSuccess(keyHash);

    if (c.get('requestId') == null) c.set('requestId', randomUUID());
    c.set('auth', {
      userId: key.userId,
      apiKeyId: key.keyId,
      appId: null,
      allowedModels: null,
      rpmLimit: positive(key.rpmLimit),
      tpmLimit: positive(key.tpmLimit),
      userRpmLimit: positive(key.userRpmLimit),
      userTpmLimit: positive(key.userTpmLimit),
    });
    await next();
  };
}
