import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { apiKeys, apps, users, isAccountUsable } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { verifyJwt } from './jwt.js';
import { appStatusCache, userProfileCache } from '@ai-gateway/http';
import { createRedisKeyAuthCache } from './key-auth-cache.js';
import {
  checkBruteForce,
  recordAuthFailure,
  resetAuthFailures,
  createRedisBruteForceStorage,
} from '../../middleware/brute-force-guard.js';
import { createAuthFailureGuard } from '../../middleware/auth-failure-guard.js';

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
  /**
   * 账户绑定的费率卡。系数不在此快照——由 resolve 步按「选中的映射」实时解析
   * （model>group>global，单一真相 ledger/coefficient.ts）；null=未绑卡（系数 1）。
   */
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
 *   - ag_ 前缀 → 静态 Key：SHA-256 查 api_keys → 校验有效 → 加载用户（含 rateCardId）
 *   - 非 ag_ → JWT：jose 验签 → jti 黑名单 → App 状态（禁用 App 的 JWT 立即失效）
 *     → 用 JWT 内 rateCardId 绑定
 *   - 系数不在此层解析：resolve 步按选中映射实时解析（ledger/coefficient.ts 单一真相）
 *
 * 安全：
 *   - 静态 Key 爆破防护（连续失败锁定，维度=keyHash，不依赖可伪造的 IP）
 *   - Key 鉴权快照走 Redis 缓存（60s，含过期复核）
 *   - App 状态缓存 60s（禁用 App → 清缓存即生效）
 */
/** 来源级鉴权失败限流默认策略（07 修复） */
export const DEFAULT_AUTH_FAILURE_LIMIT = 10;
export const DEFAULT_AUTH_FAILURE_WINDOW_S = 60;

export interface AuthServiceOptions {
  authFailureLimit?: number;
  authFailureWindowS?: number;
}

export interface AuthService {
  authenticate(header: string | undefined, sourceIp?: string): Promise<AuthResult>;
}

export function createAuthService(
  db: Db,
  redis: Redis,
  jwtSecret: string,
  options: AuthServiceOptions = {},
): AuthService {
  const bruteForce = createRedisBruteForceStorage(redis);
  const keyCache = createRedisKeyAuthCache(redis);
  const authFailureGuard = createAuthFailureGuard(redis, {
    limit: options.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT,
    windowS: options.authFailureWindowS ?? DEFAULT_AUTH_FAILURE_WINDOW_S,
  });

  /**
   * 鉴权失败 → 计数来源失败；达阈值则把响应升级为 429（07）。
   * 采用「正确凭证豁免」语义：有效 Key/JWT 永不因来源历史失败被拒，
   * 只有「本次也失败」才累计并可能 429，避免误伤共享出口 IP 的合法用户。
   */
  async function applyAuthFailureGuard(
    result: Extract<AuthResult, { ok: false }>,
    sourceIp: string,
  ): Promise<AuthResult> {
    const guard = await authFailureGuard.recordFailure(sourceIp);
    if (guard.limited) {
      return {
        ok: false,
        status: 429,
        code: 'auth_failure_rate_limited',
        message: '鉴权失败过于频繁，请稍后重试',
        suggestion: `${guard.retryAfterSec} 秒后重试`,
        retryAfterSec: guard.retryAfterSec,
      };
    }
    return result;
  }

  /** 路径 A：静态 Key（ag_ 前缀） */
  async function authenticateStaticKey(token: string): Promise<AuthResult> {
    const keyHash = createHash('sha256').update(token).digest('hex');

    // S2：暴力破解防护——锁定中直接拒绝
    const bf = await checkBruteForce(bruteForce, keyHash);
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
    const cached = await keyCache.getOrLoad(keyHash, async () => {
      // C4 修复：DB 查询直接过滤过期 Key（expires_at IS NULL 或 > now）
      const apiKey = await db.query.apiKeys.findFirst({
        where: and(
          eq(apiKeys.keyHash, keyHash),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        ),
        with: { user: true },
      });
      if (!apiKey) return null;
      return {
        userId: apiKey.userId,
        apiKeyId: apiKey.id,
        status: apiKey.status,
        rateCardId: apiKey.user.rateCardId ?? null,
        rpmLimit: apiKey.rpmLimit ?? null,
        tpmLimit: apiKey.tpmLimit ?? null,
        userStatus: apiKey.user.status,
        userRpmLimit: apiKey.user.rpmLimit ?? null,
        userTpmLimit: apiKey.user.tpmLimit ?? null,
        expiresAtMs: apiKey.expiresAt ? apiKey.expiresAt.getTime() : null,
        cachedAt: Date.now(),
      } as const;
    });

    // 认证失败（S2）：只对「已存在的真实 Key」做 per-key 失败计数（防爆破已泄露/已吊销的 Key）。
    // 07 修复：不存在的随机 Key 不写 per-key 计数——否则攻击者换随机 Key 可在 Redis 累积海量
    // `auth:fails:{hash}` 键打爆内存；对随机 Key 的限流由来源级 authFailureGuard 统一承担。
    if (!cached) {
      return { ok: false, status: 401, code: 'invalid_api_key', message: '凭证不存在' };
    }
    if (!isAccountUsable(cached.status)) {
      await recordAuthFailure(bruteForce, keyHash);
      return { ok: false, status: 401, code: 'key_revoked', message: '凭证已吊销' };
    }
    if (cached.userStatus !== 0) {
      await recordAuthFailure(bruteForce, keyHash);
      return { ok: false, status: 401, code: 'app_disabled', message: '账户已被禁用' };
    }

    // 认证成功 → 清零失败计数（S2）
    await resetAuthFailures(bruteForce, keyHash);

    return {
      ok: true,
      auth: {
        userId: cached.userId,
        apiKeyId: cached.apiKeyId,
        appId: null,
        credentialType: 'key',
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
  async function authenticateJwt(token: string): Promise<AuthResult> {
    const result = await verifyJwt(token, jwtSecret);
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

    // App 状态检查（Playground 桥 JWT 无 App，跳过）
    if (payload.appId != null) {
      // Redis 缓存 60s，避免每次查 DB；禁用 App → 清缓存即生效
      const appStatusKey = appStatusCache(payload.appId);
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
        return { ok: false, status: 401, code: 'app_disabled', message: '应用已禁用' };
      }
    }

    // 用户网关画像（status + 每用户 rpm/tpm 限流）：与静态 Key 路径对称，JWT 也必须受
    // 管理员设置的每用户限流约束（04 修复）。Redis 缓存 60s（与 app_status 同策略）；
    // 用户不存在 → '404' 拒绝。
    const userId = Number(payload.sub);
    const profileKey = userProfileCache(userId);
    let profileRaw = await redis.get(profileKey);
    if (profileRaw === null) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { status: true, rpmLimit: true, tpmLimit: true },
      });
      profileRaw = user
        ? JSON.stringify({
            status: user.status,
            rpm: user.rpmLimit ?? null,
            tpm: user.tpmLimit ?? null,
          })
        : '404';
      await redis.set(profileKey, profileRaw, 'EX', 60);
    }

    let userStatus = '404';
    let userRpmLimit: number | null = null;
    let userTpmLimit: number | null = null;
    if (profileRaw !== '404') {
      const profile = JSON.parse(profileRaw) as {
        status: number;
        rpm: number | null;
        tpm: number | null;
      };
      userStatus = String(profile.status);
      userRpmLimit = profile.rpm ?? null;
      userTpmLimit = profile.tpm ?? null;
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
        rateCardId: payload.rateCardId,
        keyRpmLimit: null,
        userRpmLimit,
        appRpmLimit: payload.scope?.rpm ?? null,
        keyTpmLimit: null,
        userTpmLimit,
        appTpmLimit: payload.scope?.tpm ?? null,
        // S3：JWT scope.models 白名单（越权防线：签了只能调 A 模型的 JWT 不能调 B）
        allowedModels: payload.scope?.models?.length ? payload.scope.models : null,
      },
    };
  }

  return {
    async authenticate(header: string | undefined, sourceIp = 'unknown'): Promise<AuthResult> {
      const token = extractBearer(header);
      if (!token) {
        return applyAuthFailureGuard(
          {
            ok: false,
            status: 401,
            code: 'invalid_api_key',
            message: '缺少 Authorization Bearer 凭证',
          },
          sourceIp,
        );
      }
      const result = token.startsWith('ag_')
        ? await authenticateStaticKey(token)
        : await authenticateJwt(token);
      if (!result.ok) {
        return applyAuthFailureGuard(result, sourceIp);
      }
      return result;
    },
  };
}
