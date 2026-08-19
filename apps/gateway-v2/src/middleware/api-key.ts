/**
 * API Key 鉴权中间件：Authorization: Bearer ag_xxx → SHA-256 查 api_keys
 * （status=0 且未过期，repo 单语句守卫）→ 请求级 RunContext 挂上下文。
 * 业务鉴权语义在 repo / service；本层只做协议提取与拒绝翻译。
 *
 * 爆破防护（两层，Redis 装配注入；未装配 = 单副本开发形态，跳过）：
 *   - per-keyHash：单 Key 爆破（失败计数 → 锁定；成功清零）
 *   - per-IP：换随机 Key 无差别刷鉴权失败的来源锁定（限流在鉴权之后，
 *     鉴权失败走不到限流器——此层独立兜住）
 * 两层均 fail-closed：Redis 故障按不可用拒绝（503）——防爆破语义不因缓存故障消失。
 */
import { createHash, randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { createRepositories } from '@ai-gateway/repository';
import type { Db } from '@ai-gateway/repository';
import { socketAddressFromContext, trustedClientIp } from '@ai-gateway/http';
import type { AuthFailureGuard, KeyBruteForceGuard } from '@ai-gateway/core';
import { systemContext, type RunContext } from '@ai-gateway/service';
import { UnauthorizedError } from '../http/error-map.js';

export interface AuthContext {
  userId: number;
  /** 静态 Key 凭证（JWT 凭证为 null——限流维度退到 user） */
  apiKeyId: number | null;
  /** App JWT 凭证（playground/静态 Key 为 null） */
  appId: number | null;
  /** 模型白名单（App JWT scope.models；null = 不限——准入与 /v1/models 过滤的单一真相） */
  allowedModels: string[] | null;
  subscriptionId: number | null;
  allowPaygFallback: boolean;
  /** 凭证级限流（null/0 = 不限；限流闸消费） */
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 用户级限流（users.rpm/tpm_limit——与凭证级并罚，不互相覆盖） */
  userRpmLimit: number | null;
  userTpmLimit: number | null;
  ctx: RunContext;
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
  /** 用户级限流兜底（凭证/Scope 未声明时生效；0 = 不限——v1 DEFAULT_USER_RPM 语义） */
  defaultUserRpm?: number;
  defaultUserTpm?: number;
}

/** 限额有效性（0/null/undefined = 不限维） */
function positive(v: number | null | undefined): number | null {
  return v != null && v > 0 ? v : null;
}

const KEY_PREFIX = 'ag_';

/** JWT 凭证载荷（/oauth/token 的 app_jwt 与控制台操练场的 playground 两形态） */
interface GatewayJwtPayload {
  typ?: string;
  sub?: string;
  app_id?: number;
  scope?: { rpm?: number; tpm?: number; models?: string[] };
}

export function apiKeyMiddleware(
  db: Db,
  guards: AuthGuards | undefined,
  jwtSecret: string,
): MiddlewareHandler<AuthEnv> {
  const repos = createRepositories();
  // 真实 socket 对端地址必须注入：置 null 时 trustedClientIp 落到进程级常量，
  // 全部客户端共享同一个 IP 桶——per-IP 爆破锁退化为「一人刷失败、全员被锁」的
  // 全局拒绝服务开关（app.request 测试无连接信息 → null 是测试唯一合法形态）
  const sourceIpOf = (c: Parameters<MiddlewareHandler<AuthEnv>>[0]): string =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: guards?.trustedProxyHops ?? 0,
      socketAddress: socketAddressFromContext(c),
    });

  const verifyJwt = async (token: string): Promise<GatewayJwtPayload> => {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      issuer: 'ai-gateway',
      audience: 'ai-gateway-api',
      algorithms: ['HS256'], // 算法族白名单（防混淆攻击；v1 对位）
    }).catch(() => {
      throw new UnauthorizedError('invalid or expired jwt credential');
    });
    return payload as unknown as GatewayJwtPayload;
  };

  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    // ---- JWT 凭证分支（App JWT / 操练场）：计费与限流走同一管线，维度退到 user ----
    if (!token.startsWith(KEY_PREFIX)) {
      if (!token) throw new UnauthorizedError('missing or malformed api key');
      const payload = await verifyJwt(token);
      const requestId = c.get('requestId') ?? randomUUID();
      if (payload.typ === 'app_jwt' && payload.app_id != null && payload.sub != null) {
        const app = await repos.credential.findActiveAppById(
          { ...systemContext('gateway-auth'), db },
          payload.app_id,
        );
        if (!app || app.userId !== Number(payload.sub)) throw new UnauthorizedError('app credential inactive');
        c.set('auth', {
          userId: app.userId,
          apiKeyId: null,
          appId: app.id,
          subscriptionId: app.subscriptionId,
          allowPaygFallback: false, // App JWT 恒 false（与 resolveSourceAndLimits 同口径）
          rpmLimit: positive(payload.scope?.rpm),
          tpmLimit: positive(payload.scope?.tpm),
          userRpmLimit: positive(app.userRpmLimit) ?? positive(guards?.defaultUserRpm),
          userTpmLimit: positive(app.userTpmLimit) ?? positive(guards?.defaultUserTpm),
          allowedModels: Array.isArray(payload.scope?.models) && payload.scope.models.length > 0 ? payload.scope.models : null,
          ctx: { requestId, actor: { kind: 'user', id: app.userId }, traceParent: null },
        });
        await next();
        return;
      }
      if (payload.typ === 'playground' && payload.sub != null) {
        const userId = Number(payload.sub);
        // 属主状态核验（v1 对位）：封禁/删除用户的存量 playground JWT 不得在 TTL 窗口内继续放行
        const active = await repos.credential.findActiveUserById(
          { ...systemContext('gateway-auth'), db },
          userId,
        );
        if (!active) throw new UnauthorizedError('account unavailable');
        c.set('auth', {
          userId,
          apiKeyId: null,
          appId: null,
          subscriptionId: null,
          allowPaygFallback: false,
          rpmLimit: positive(payload.scope?.rpm),
          tpmLimit: positive(payload.scope?.tpm),
          userRpmLimit: positive(active.rpmLimit) ?? positive(guards?.defaultUserRpm),
          userTpmLimit: positive(active.tpmLimit) ?? positive(guards?.defaultUserTpm),
          allowedModels: null,
          ctx: { requestId, actor: { kind: 'user', id: userId }, traceParent: null },
        });
        await next();
        return;
      }
      throw new UnauthorizedError('unsupported jwt credential type');
    }

    const keyHash = createHash('sha256').update(token).digest('hex');

    if (guards) {
      const keyLock = await guards.keyGuard.isLocked(keyHash);
      if (keyLock.locked) throw new UnauthorizedError(`api key locked, retry after ${keyLock.retryAfterSec}s`);
      const ipLock = await guards.ipGuard.isLocked(sourceIpOf(c));
      if (ipLock.locked) throw new UnauthorizedError(`source locked, retry after ${ipLock.retryAfterSec}s`);
    }

    const key = await repos.credential.findActiveKeyByKeyHash({ ...systemContext('gateway-auth'), db }, keyHash);
    if (!key) {
      if (guards) {
        await guards.keyGuard.recordFailure(keyHash);
        await guards.ipGuard.recordFailure(sourceIpOf(c));
      }
      throw new UnauthorizedError();
    }
    if (guards) await guards.keyGuard.recordSuccess(keyHash);

    const requestId = c.get('requestId') ?? randomUUID();
    c.set('auth', {
      userId: key.userId,
      apiKeyId: key.id,
      appId: null,
      subscriptionId: key.subscriptionId,
      allowPaygFallback: key.allowPaygFallback,
      rpmLimit: positive(key.rpmLimit),
      tpmLimit: positive(key.tpmLimit),
      userRpmLimit: positive(key.userRpmLimit) ?? positive(guards?.defaultUserRpm),
      userTpmLimit: positive(key.userTpmLimit) ?? positive(guards?.defaultUserTpm),
      allowedModels: null,
      ctx: { requestId, actor: { kind: 'user', id: key.userId }, traceParent: null },
    });
    await next();
  };
}
