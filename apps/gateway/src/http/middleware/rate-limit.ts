/**
 * 限流闸（v1 rate-limit/gate.ts 迁移；机制归 @tokenlens/runtime limiter，策略在此）：
 * 并罚制——任一维（key/user RPM、key/user/global TPM）超限即 429，不做凭证>用户择优；
 * 维度串不外泄（Retry-After 头表达等待）；TPM 预占失败必须 releaseTpm（TTL 兜底）。
 *
 * v2 裁决（IMPLEMENTATION §1 A10，R-E3）：模型维 TPM（v1 reserveModelDims）与渠道维
 * TPM 预占不在本波——前者需目录候选映射 id（inference 内部解析），后者需请求作用域
 * TPM 生命周期（admitChannel 钩子无 requestId 维）。渠道维 RPM 经 assembly 注入的
 * admitChannel 钩子保留（production-hardening「渠道超限换渠」语义）。
 */
import { randomUUID } from 'node:crypto';
import type { SlidingWindowLimiter } from '@tokenlens/runtime';
import { GatewayErrors } from '../openai-error-face';
import type { AuthContext } from './api-key';

export interface RateLimitGate {
  limiter: SlidingWindowLimiter;
  /** null = 无全局维 */
  globalRpm: number | null;
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

function admitDimensions(auth: AuthContext): Array<{ dimension: string; max: number }> {
  const dims: Array<{ dimension: string; max: number }> = [];
  if (auth.apiKeyId != null) {
    if (auth.rpmLimit != null) dims.push({ dimension: `key:${auth.apiKeyId}`, max: auth.rpmLimit });
    if (auth.tpmLimit != null) dims.push({ dimension: `key:${auth.apiKeyId}`, max: auth.tpmLimit });
  }
  return dims;
}

/** 请求准入（路由入口调用）：RPM 多维原子检查 + TPM 预占；拒绝抛 gateway.rate_limit_exceeded */
export async function admitRequest(
  gate: RateLimitGate | undefined,
  input: AdmitInput,
): Promise<AdmitHandle> {
  if (gate == null) return { release: async () => undefined };
  const { auth } = input;
  const rpmDims: Array<{ dimension: string; max: number }> = [];
  if (auth.apiKeyId != null && auth.rpmLimit != null) {
    rpmDims.push({ dimension: `key:${auth.apiKeyId}`, max: auth.rpmLimit });
  }
  if (auth.userRpmLimit != null) rpmDims.push({ dimension: `user:${auth.userId}`, max: auth.userRpmLimit });
  if (gate.globalRpm != null) rpmDims.push({ dimension: 'global', max: gate.globalRpm });

  const rpm = await gate.limiter.checkAll(rpmDims, input.requestId);
  if (!rpm.allowed) {
    throw GatewayErrors.business('rate_limit_exceeded', {
      retryAfterSec: rpm.retryAfterSec ?? 60,
    });
  }

  const tpmDims: Array<{ dimension: string; estimatedTokens: number; max: number }> = [];
  if (auth.apiKeyId != null && auth.tpmLimit != null) {
    tpmDims.push({ dimension: `key:${auth.apiKeyId}`, estimatedTokens: input.estimatedTokens, max: auth.tpmLimit });
  }
  if (auth.userTpmLimit != null) {
    tpmDims.push({ dimension: `user:${auth.userId}`, estimatedTokens: input.estimatedTokens, max: auth.userTpmLimit });
  }
  if (tpmDims.length > 0) {
    const tpm = await gate.limiter.reserveTpmAll(tpmDims, input.requestId);
    if (!tpm.allowed) {
      // RPM 已计数不撤销（v1 同语义：并罚不留回滚路径）；TPM 未预占无需释放
      throw GatewayErrors.business('rate_limit_exceeded', {
        retryAfterSec: tpm.retryAfterSec ?? 60,
      });
    }
  }
  return {
    release: () => gate.limiter.releaseTpm(input.requestId),
  };
}

/** 渠道维 RPM 尝试前判定（assembly 经 inference admitChannel 钩子消费；false = 换渠） */
export async function tryChannelRpm(
  gate: RateLimitGate | undefined,
  channel: { channelId: number; rpmLimit: number | null },
): Promise<boolean> {
  if (gate == null || channel.rpmLimit == null || channel.rpmLimit <= 0) return true;
  const result = await gate.limiter.check(`channel:${channel.channelId}`, channel.rpmLimit, randomUUID());
  return result.allowed;
}

export { admitDimensions };
