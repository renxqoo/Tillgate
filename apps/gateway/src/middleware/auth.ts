import type { Context, MiddlewareHandler } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { apiKeys, apps, rateCardCoefficients } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { verifyJwt } from '../lib/jwt.js';
import { env } from '../index.js';
import {
  checkBruteForce,
  recordAuthFailure,
  resetAuthFailures,
  createRedisBruteForceStorage,
} from './brute-force-guard.js';
import { createRedisKeyAuthCache } from '../lib/key-auth-cache.js';

/**
 * 鉴权上下文（鉴权通过后挂在 c.var.auth，后续路由/计量使用）
 * 一期最小闭环：仅静态 Key（ag_ 前缀）。JWT（企业 Agent）后续补。
 */
export interface AuthContext {
  userId: number;
  /** 静态 Key 鉴权时有值；JWT 鉴权时为 null */
  apiKeyId: number | null;
  /** JWT 鉴权时有值；静态 Key 时为 null */
  appId: number | null;
  /** key / jwt（计量记录用） */
  credentialType: 'key' | 'jwt';
  /** 费率卡系数（毫，1.0 = 1000），用于计费 */
  coefficientMilli: number;
  rateCardId: number | null;
  /** Key 级 RPM 限流（null = 继承用户/全局） */
  keyRpmLimit: number | null;
  /** 用户级 RPM 限流（null = 继承全局默认） */
  userRpmLimit: number | null;
  /** JWT scope 里的 rpm 限制（App 级，优先于用户） */
  appRpmLimit: number | null;
  /** Key 级 TPM 限流（null = 继承用户/全局） */
  keyTpmLimit: number | null;
  /** 用户级 TPM 限流（null = 继承全局默认） */
  userTpmLimit: number | null;
  /** JWT scope 里的 tpm 限制（App 级） */
  appTpmLimit: number | null;
  /** JWT scope 里的模型白名单（null = 不限；静态 Key 不限）。chat 路由据此校验越权 */
  allowedModels: string[] | null;
}

export interface AuthEnv {
  Variables: {
    auth: AuthContext;
    requestId: string;
  };
}

/** 从 Authorization header 提取 Bearer token */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/**
 * 双凭证鉴权中间件（requirements 4.2）：
 *   - ag_ 前缀 → 静态 Key：SHA-256 查 api_keys → 校验有效 → 加载用户+费率卡
 *   - 非 ag_ → JWT：jose 验签 → 查 App 状态（禁用 App 的 JWT 立即失效）→ 用 JWT 内 coefficient 快照
 *
 * jti 黑名单（单令牌吊销）+ App 状态缓存（Redis）留后续优化。
 */
export function authMiddleware(db: Db, redis: Redis): MiddlewareHandler<AuthEnv> {
  const bruteForce = createRedisBruteForceStorage(redis);
  const keyCache = createRedisKeyAuthCache(redis);
  return async (c, next) => {
    const token = extractBearer(c.req.header('authorization'));
    if (!token) {
      return errorResponse(c, 401, 'invalid_api_key', '缺少 Authorization Bearer 凭证');
    }

    // ---- 路径 A：静态 Key（ag_ 前缀）----
    if (token.startsWith('ag_')) {
      const keyHash = createHash('sha256').update(token).digest('hex');

      // S2：暴力破解防护——锁定中直接拒绝
      const bf = await checkBruteForce(bruteForce, keyHash);
      if (bf.locked) {
        c.header('retry-after', String(bf.retryAfterSec));
        return errorResponse(c, 429, 'key_locked', '凭证已被临时锁定（连续认证失败）', `${bf.retryAfterSec} 秒后重试`);
      }

      // S5：Redis 缓存 keyHash → 鉴权快照（cache miss 才查 DB）
      const cached = await keyCache.getOrLoad(keyHash, async () => {
        const apiKey = await db.query.apiKeys.findFirst({
          where: eq(apiKeys.keyHash, keyHash),
          with: { user: true },
        });
        if (!apiKey) return null;
        // 查费率卡系数
        let coefficientMilli = 1000;
        if (apiKey.user.rateCardId) {
          const coeff = await db.query.rateCardCoefficients.findFirst({
            where: and(
              eq(rateCardCoefficients.rateCardId, apiKey.user.rateCardId),
              eq(rateCardCoefficients.scope, 'global'),
              isNull(rateCardCoefficients.modelMappingId),
            ),
          });
          if (coeff) coefficientMilli = Math.round(Number(coeff.coefficient) * 1000);
        }
        return {
          userId: apiKey.userId,
          apiKeyId: apiKey.id,
          status: apiKey.status,
          rateCardId: apiKey.user.rateCardId ?? null,
          coefficientMilli,
          rpmLimit: apiKey.rpmLimit ?? null,
          tpmLimit: apiKey.tpmLimit ?? null,
          userStatus: apiKey.user.status,
          userRpmLimit: apiKey.user.rpmLimit ?? null,
          userTpmLimit: apiKey.user.tpmLimit ?? null,
          cachedAt: Date.now(),
        } as const;
      });

      // 认证失败 → 记录（S2：失败计数递增，达阈值自动锁）
      if (!cached) {
        await recordAuthFailure(bruteForce, keyHash);
        return errorResponse(c, 401, 'invalid_api_key', '凭证不存在');
      }
      if (cached.status !== 0) {
        await recordAuthFailure(bruteForce, keyHash);
        return errorResponse(c, 401, 'key_revoked', '凭证已吊销');
      }
      if (cached.userStatus !== 0) {
        await recordAuthFailure(bruteForce, keyHash);
        return errorResponse(c, 401, 'app_disabled', '账户已被禁用');
      }

      // 认证成功 → 清零失败计数（S2）
      await resetAuthFailures(bruteForce, keyHash);

      c.set('auth', {
        userId: cached.userId,
        apiKeyId: cached.apiKeyId,
        appId: null,
        credentialType: 'key' as const,
        coefficientMilli: cached.coefficientMilli,
        rateCardId: cached.rateCardId,
        keyRpmLimit: cached.rpmLimit,
        userRpmLimit: cached.userRpmLimit,
        appRpmLimit: null,
        keyTpmLimit: cached.tpmLimit,
        userTpmLimit: cached.userTpmLimit,
        appTpmLimit: null,
        allowedModels: null, // 静态 Key 不限模型
      });
      await next();
      return;
    }

    // ---- 路径 B：JWT（企业 Agent）----
    const result = await verifyJwt(token, env.JWT_SECRET);
    if (!result.ok) {
      const code = result.error === 'token_expired' ? 'token_expired' : 'invalid_token';
      return errorResponse(c, 401, code, result.error === 'token_expired' ? 'Token 已过期' : 'Token 无效');
    }
    const payload = result.payload!;

    // jti 黑名单检查（单令牌紧急吊销：管理端 SET jti_blacklist:{jti} EX <剩余有效期>）
    const jtiBlocked = await redis.get(`jti_blacklist:${payload.jti}`);
    if (jtiBlocked !== null) {
      return errorResponse(c, 401, 'token_revoked', '令牌已被吊销');
    }

    // App 状态检查（Redis 缓存 60s，避免每次查 DB；禁用 App → 清缓存即生效）
    const appStatusKey = `app_status:${payload.appId}`;
    let appStatus = await redis.get(appStatusKey);
    if (appStatus === null) {
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, payload.appId),
        columns: { status: true },
      });
      appStatus = app ? String(app.status) : '404';
      await redis.set(appStatusKey, appStatus, 'EX', 60);
    }
    if (appStatus !== '0') {
      return errorResponse(c, 401, 'app_disabled', '应用已禁用');
    }

    c.set('auth', {
      userId: Number(payload.sub),
      apiKeyId: null,
      appId: payload.appId,
      credentialType: 'jwt' as const,
      coefficientMilli: Math.round(payload.coefficient * 1000),
      rateCardId: null,
      keyRpmLimit: null,
      userRpmLimit: null, // JWT 路径不查 DB 用户限流（用 scope 内的）
      appRpmLimit: payload.scope?.rpm ?? null,
      keyTpmLimit: null,
      userTpmLimit: null,
      appTpmLimit: payload.scope?.tpm ?? null,
      // S3：JWT scope.models 白名单（越权防线：签了只能调 A 模型的 JWT 不能调 B）
      allowedModels: payload.scope?.models?.length ? payload.scope.models : null,
    });

    await next();
  };
}

/** OpenAI 风格错误信封（api-contract.md §3） */
export function errorResponse(
  c: Context,
  status: number,
  code: string,
  message: string,
  suggestion?: string,
): Response {
  return c.json(
    {
      error: {
        message,
        type: 'invalid_request_error',
        code,
        param: null,
        request_id: c.var.requestId ?? null,
        suggestion: suggestion ?? null,
      },
    },
    status as 401,
  );
}
