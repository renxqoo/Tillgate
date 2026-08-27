/**
 * 限流闸（机制归 @tillgate/runtime limiter，策略在此）：
 * 并罚制——任一维（key/user RPM、key/user/global TPM）超限即 429，不做凭证>用户择优；
 * 维度串不外泄（Retry-After 头表达等待）；TPM 预占失败必须 releaseTpm（TTL 兜底）。
 *
 * 范围说明：模型维 TPM 与渠道维 TPM 预占不在本闸——前者需目录候选映射 id
 * （inference 内部解析），后者需请求作用域 TPM 生命周期（admitChannel 钩子无
 * requestId 维）。渠道维 RPM 经 assembly 注入的 admitChannel 钩子保留
 * （渠道超限换渠语义）。
 */
import { randomUUID } from 'node:crypto';
import type { SlidingWindowLimiter } from '@tillgate/runtime';
import type { MiddlewareHandler } from 'hono';
import { socketAddressFromContext, trustedClientIp } from '@tillgate/http';
import { getTracer, withAsyncSpan } from '@tillgate/observability';
import { GatewayErrors } from '../openai-error-face';
import type { AuthContext, AuthEnv } from './api-key';

export interface RateLimitGate {
  limiter: SlidingWindowLimiter;
  /** null = 无全局维 */
  globalRpm: number | null;
  /** 预认证 per-IP RPM 上限（null = 不设该闸）；鉴权前的第一道闸 */
  preauthIpRpm: number | null;
}

export interface AdmitInput {
  requestId: string;
  auth: AuthContext;
  /** TPM 预占口径的估算 token 数（敞口保守上界） */
  estimatedTokens: number;
}

export interface AdmitHandle {
  /** TPM 预占归还（无上游执行的失败路径必须调用；幂等） */
  release(): Promise<void>;
}

/** RPM 维表（key/user/global 并罚——任一维超限即拒） */
function rpmDimsOf(
  gate: RateLimitGate,
  auth: AuthContext,
): Array<{ dimension: string; max: number }> {
  const dims: Array<{ dimension: string; max: number }> = [];
  if (auth.apiKeyId != null && auth.rpmLimit != null) {
    dims.push({ dimension: `key:${auth.apiKeyId}`, max: auth.rpmLimit });
  }
  if (auth.userRpmLimit != null) {
    dims.push({ dimension: `user:${auth.userId}`, max: auth.userRpmLimit });
  }
  if (gate.globalRpm != null) dims.push({ dimension: 'global', max: gate.globalRpm });
  return dims;
}

/** TPM 维表（key/user 预占——凭证维缺失跳过） */
function tpmDimsOf(
  auth: AuthContext,
  estimatedTokens: number,
): Array<{ dimension: string; estimatedTokens: number; max: number }> {
  const dims: Array<{ dimension: string; estimatedTokens: number; max: number }> = [];
  if (auth.apiKeyId != null && auth.tpmLimit != null) {
    dims.push({ dimension: `key:${auth.apiKeyId}`, estimatedTokens, max: auth.tpmLimit });
  }
  if (auth.userTpmLimit != null) {
    dims.push({ dimension: `user:${auth.userId}`, estimatedTokens, max: auth.userTpmLimit });
  }
  return dims;
}

/** 请求准入（路由入口调用）：RPM 多维原子检查 + TPM 预占；拒绝抛 gateway.rate_limit_exceeded。
 *  准入整段包 rate_limit.admit span（拒绝 = ERROR + 异常记录）。 */
export async function admitRequest(
  gate: RateLimitGate | undefined,
  input: AdmitInput,
): Promise<AdmitHandle> {
  if (gate == null) return { release: async () => {} };
  const { auth } = input;
  let credentialDimension = `pg:${auth.userId}`;
  if (auth.apiKeyId != null) credentialDimension = `key:${auth.apiKeyId}`;
  else if (auth.appId != null) credentialDimension = `app:${auth.appId}`;
  return await withAsyncSpan(
    getTracer('gateway'),
    'rate_limit.admit',
    {
      'request.id': input.requestId,
      'user.id': auth.userId,
      'rate_limit.credential_dim': credentialDimension,
      'tokens.estimate': input.estimatedTokens,
    },
    async () => {
      const rpm = await gate.limiter.checkAll(rpmDimsOf(gate, auth), input.requestId);
      if (!rpm.allowed) {
        throw GatewayErrors.business('rate_limit_exceeded', {
          retryAfterSec: rpm.retryAfterSec ?? 60,
        });
      }

      const tpmDims = tpmDimsOf(auth, input.estimatedTokens);
      if (tpmDims.length > 0) {
        const tpm = await gate.limiter.reserveTpmAll(tpmDims, input.requestId);
        if (!tpm.allowed) {
          // RPM 已计数不撤销（并罚不留回滚路径）；TPM 未预占无需释放
          throw GatewayErrors.business('rate_limit_exceeded', {
            retryAfterSec: tpm.retryAfterSec ?? 60,
          });
        }
      }
      return {
        release: () => gate.limiter.releaseTpm(input.requestId),
      };
    },
  );
}

/** 渠道维 RPM 尝试前判定（assembly 经 inference admitChannel 钩子消费；false = 换渠） */
export async function tryChannelRpm(
  gate: RateLimitGate | undefined,
  channel: { channelId: number; rpmLimit: number | null },
): Promise<boolean> {
  if (gate == null || channel.rpmLimit == null || channel.rpmLimit <= 0) return true;
  const result = await gate.limiter.check(
    `channel:${channel.channelId}`,
    channel.rpmLimit,
    randomUUID(),
  );
  return result.allowed;
}

/**
 * 预认证 per-IP 限流中间件（/v1/* 与 /v1beta/* 共用同一 IP 桶）：
 * 鉴权维度限流（key/user/global）全部依赖 AuthContext——未认证洪水不经过任何闸，
 * 且每发请求都写一行 request_logs（写放大）。本闸挂在 requestLog 之前：
 * 超限 429 直接出站、不写日志。Redis 故障 fail-closed（与 admitRequest 同语义）。
 */
export function preauthIpRateLimitMiddleware(gate: {
  limiter: SlidingWindowLimiter;
  maxPerMinute: number;
  trustedProxyHops: number;
}): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const ip = trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: gate.trustedProxyHops,
      socketAddress: socketAddressFromContext(c),
    });
    const requestId = c.get('requestId');
    const result = await gate.limiter.check(`preauth-ip:${ip}`, gate.maxPerMinute, requestId);
    if (!result.allowed) {
      throw GatewayErrors.business('rate_limit_exceeded', {
        retryAfterSec: result.retryAfterSec ?? 60,
      });
    }
    await next();
  };
}
