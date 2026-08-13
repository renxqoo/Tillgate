import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { apiKeys, apps, rateCardCoefficients, users } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { verifyJwt } from './jwt.js';
import { createRedisKeyAuthCache } from './key-auth-cache.js';
import {
  checkBruteForce,
  recordAuthFailure,
  resetAuthFailures,
  createRedisBruteForceStorage,
} from '../../middleware/brute-force-guard.js';

/**
 * 鉴权上下文（鉴权通过后挂在 c.var.auth，后续路由/计量使用）。
 * 静态 Key（ag_ 前缀）与 JWT（企业 Agent）双凭证，字段语义：
 *   - apiKeyId/appId 二选一非空，标识凭证来源
 *   - 各维度限流为 null 时继承上层默认
 */
export interface AuthContext {
  userId: number;
  /** 静态 Key 鉴权时有值；JWT 鉴权时为 null */
  apiKeyId: number | null;
  /** JWT 鉴权时有值；静态 Key 时为 null */
  appId: number | null;
  /** key / jwt（计量记录用） */
  credentialType: 'key' | 'jwt';
  /** 费率卡系数（小数 string，如 "1.0"），用于计费 */
  coefficient: string;
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
  /** JWT scope 里的模型白名单（null = 不限；静态 Key 不限）。路由据此校验越权 */
  allowedModels: string[] | null;
}

export type AuthResult =
  | { ok: true; auth: AuthContext }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      suggestion?: string;
      retryAfterSec?: number;
    };

/** 从 Authorization header 提取 Bearer token */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/**
 * 双凭证鉴权服务（requirements 4.2）：
 *   - ag_ 前缀 → 静态 Key：SHA-256 查 api_keys → 校验有效 → 加载用户+费率卡
 *   - 非 ag_ → JWT：jose 验签 → jti 黑名单 → App 状态（禁用 App 的 JWT 立即失效）
 *     → 用 JWT 内 coefficient 快照
 *
 * 安全：
 *   - 静态 Key 爆破防护（连续失败锁定，维度=keyHash，不依赖可伪造的 IP）
 *   - Key 鉴权快照走 Redis 缓存（60s，含过期复核）
 *   - App 状态缓存 60s（禁用 App → 清缓存即生效）
 */
export class AuthService {
  private readonly bruteForce: ReturnType<typeof createRedisBruteForceStorage>;
  private readonly keyCache: ReturnType<typeof createRedisKeyAuthCache>;

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly jwtSecret: string,
  ) {
    this.bruteForce = createRedisBruteForceStorage(redis);
    this.keyCache = createRedisKeyAuthCache(redis);
  }

  async authenticate(header: string | undefined): Promise<AuthResult> {
    const token = extractBearer(header);
    if (!token) {
      return {
        ok: false,
        status: 401,
        code: 'invalid_api_key',
        message: '缺少 Authorization Bearer 凭证',
      };
    }
    return token.startsWith('ag_')
      ? this.authenticateStaticKey(token)
      : this.authenticateJwt(token);
  }

  /** 路径 A：静态 Key（ag_ 前缀） */
  private async authenticateStaticKey(token: string): Promise<AuthResult> {
    const keyHash = createHash('sha256').update(token).digest('hex');

    // S2：暴力破解防护——锁定中直接拒绝
    const bf = await checkBruteForce(this.bruteForce, keyHash);
    if (bf.locked) {
      return {
        ok: false,
        status: 429,
        code: 'key_locked',
        message: '凭证已被临时锁定（连续认证失败）',
        suggestion: `${bf.retryAfterSec} 秒后重试`,
        retryAfterSec: bf.retryAfterSec,
      };
    }

    // S5：Redis 缓存 keyHash → 鉴权快照（cache miss 才查 DB）
    const cached = await this.keyCache.getOrLoad(keyHash, async () => {
      // C4 修复：DB 查询直接过滤过期 Key（expires_at IS NULL 或 > now）
      const apiKey = await this.db.query.apiKeys.findFirst({
        where: and(
          eq(apiKeys.keyHash, keyHash),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        ),
        with: { user: true },
      });
      if (!apiKey) return null;
      // 查费率卡系数（小数 string，如 "1.0"）
      let coefficient = '1';
      if (apiKey.user.rateCardId) {
        const coeff = await this.db.query.rateCardCoefficients.findFirst({
          where: and(
            eq(rateCardCoefficients.rateCardId, apiKey.user.rateCardId),
            eq(rateCardCoefficients.scope, 'global'),
            isNull(rateCardCoefficients.modelMappingId),
          ),
        });
        if (coeff) coefficient = String(coeff.coefficient);
      }
      return {
        userId: apiKey.userId,
        apiKeyId: apiKey.id,
        status: apiKey.status,
        rateCardId: apiKey.user.rateCardId ?? null,
        coefficient,
        rpmLimit: apiKey.rpmLimit ?? null,
        tpmLimit: apiKey.tpmLimit ?? null,
        userStatus: apiKey.user.status,
        userRpmLimit: apiKey.user.rpmLimit ?? null,
        userTpmLimit: apiKey.user.tpmLimit ?? null,
        expiresAtMs: apiKey.expiresAt ? apiKey.expiresAt.getTime() : null,
        cachedAt: Date.now(),
      } as const;
    });

    // 认证失败 → 记录（S2：失败计数递增，达阈值自动锁）
    if (!cached) {
      await recordAuthFailure(this.bruteForce, keyHash);
      return { ok: false, status: 401, code: 'invalid_api_key', message: '凭证不存在' };
    }
    if (cached.status !== 0) {
      await recordAuthFailure(this.bruteForce, keyHash);
      return { ok: false, status: 401, code: 'key_revoked', message: '凭证已吊销' };
    }
    if (cached.userStatus !== 0) {
      await recordAuthFailure(this.bruteForce, keyHash);
      return { ok: false, status: 401, code: 'app_disabled', message: '账户已被禁用' };
    }

    // 认证成功 → 清零失败计数（S2）
    await resetAuthFailures(this.bruteForce, keyHash);

    return {
      ok: true,
      auth: {
        userId: cached.userId,
        apiKeyId: cached.apiKeyId,
        appId: null,
        credentialType: 'key',
        coefficient: cached.coefficient,
        rateCardId: cached.rateCardId,
        keyRpmLimit: cached.rpmLimit,
        userRpmLimit: cached.userRpmLimit,
        appRpmLimit: null,
        keyTpmLimit: cached.tpmLimit,
        userTpmLimit: cached.userTpmLimit,
        appTpmLimit: null,
        allowedModels: null, // 静态 Key 不限模型
      },
    };
  }

  /** 路径 B：JWT（企业 Agent） */
  private async authenticateJwt(token: string): Promise<AuthResult> {
    const result = await verifyJwt(token, this.jwtSecret);
    if (!result.ok) {
      const code = result.error === 'token_expired' ? 'token_expired' : 'invalid_token';
      return {
        ok: false,
        status: 401,
        code,
        message: result.error === 'token_expired' ? 'Token 已过期' : 'Token 无效',
      };
    }
    const payload = result.payload!;

    // jti 黑名单检查（单令牌紧急吊销：管理端 SET jti_blacklist:{jti} EX <剩余有效期>）
    const jtiBlocked = await this.redis.get(`jti_blacklist:${payload.jti}`);
    if (jtiBlocked !== null) {
      return { ok: false, status: 401, code: 'token_revoked', message: '令牌已被吊销' };
    }

    // App 状态检查（Redis 缓存 60s，避免每次查 DB；禁用 App → 清缓存即生效）
    const appStatusKey = `app_status:${payload.appId}`;
    let appStatus = await this.redis.get(appStatusKey);
    if (appStatus === null) {
      const app = await this.db.query.apps.findFirst({
        where: eq(apps.id, payload.appId),
        columns: { status: true },
      });
      appStatus = app ? String(app.status) : '404';
      await this.redis.set(appStatusKey, appStatus, 'EX', 60);
    }
    if (appStatus !== '0') {
      return { ok: false, status: 401, code: 'app_disabled', message: '应用已禁用' };
    }

    // 用户状态检查（与静态 Key 路径对称：封禁/注销用户立即失效，而非等 JWT 过期）。
    // Redis 缓存 60s（与 app_status 同策略）；用户不存在 → '404' 拒绝。
    const userId = Number(payload.sub);
    const userStatusKey = `user_status:${userId}`;
    let userStatus = await this.redis.get(userStatusKey);
    if (userStatus === null) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { status: true },
      });
      userStatus = user ? String(user.status) : '404';
      await this.redis.set(userStatusKey, userStatus, 'EX', 60);
    }
    if (userStatus !== '0') {
      return { ok: false, status: 401, code: 'user_disabled', message: '账户已被禁用' };
    }

    return {
      ok: true,
      auth: {
        userId,
        apiKeyId: null,
        appId: payload.appId,
        credentialType: 'jwt',
        coefficient: String(payload.coefficient),
        rateCardId: null,
        keyRpmLimit: null,
        userRpmLimit: null, // JWT 路径不查 DB 用户限流（用 scope 内的）
        appRpmLimit: payload.scope?.rpm ?? null,
        keyTpmLimit: null,
        userTpmLimit: null,
        appTpmLimit: payload.scope?.tpm ?? null,
        // S3：JWT scope.models 白名单（越权防线：签了只能调 A 模型的 JWT 不能调 B）
        allowedModels: payload.scope?.models?.length ? payload.scope.models : null,
      },
    };
  }
}
