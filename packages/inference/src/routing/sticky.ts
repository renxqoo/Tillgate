import { createHash } from 'node:crypto';
import type { RequestAuth } from '../domain/model/types';
import type { StickyStore } from '../ports/routing';
import type { RoutingPolicy } from './policy';

/**
 * cache 亲和路由指纹与粘滞（KV cache 经济性——换渠道 = prompt cache 全丢）：
 *   指纹 = sha256(凭证维 ‖ messages 前缀)。多轮对话 append-only，前缀稳定 →
 *   同一会话粘住同一渠道；渠道熔断/惩罚/预算不足时 gates 拦截，不粘（可用性
 *   永远优先于亲和）；失败换渠后下一轮指纹不变 → 渠道恢复自动换回（cache 还在）。
 *   命中与续期均在成功结算后写（失败请求不污染粘滞）。
 */

/** 请求侧路由指纹输入（auth + 模型/端点 + 原始 body 的 messages 序列化前缀） */
export interface StickyFingerprintInput {
  auth: RequestAuth;
  body: Record<string, unknown>;
  /** 模型/端点入指纹：embeddings 等无 messages 请求不得共享同一键（无 cache 收益反致流量垄断） */
  externalModel?: string;
  endpoint?: string;
}

export function stickyKeyOf(input: StickyFingerprintInput, prefixChars: number): string {
  const { apiKeyId, appId, userId } = input.auth;
  let credential = `user:${userId}`;
  if (apiKeyId != null) credential = `key:${apiKeyId}`;
  else if (appId != null) credential = `app:${appId}`;
  const { messages } = input.body;
  const serialized = typeof messages === 'string' ? messages : JSON.stringify(messages ?? '');
  const prefix = serialized.length > prefixChars ? serialized.slice(0, prefixChars) : serialized;
  const scope = `${input.endpoint ?? ''}|${input.externalModel ?? ''}`;
  return `sticky:${createHash('sha256').update(`${credential}|${scope}|${prefix}`).digest('hex')}`;
}

/** 解析当前请求的粘滞渠道（fail-open：存储故障 = 无粘滞） */
export async function resolveStickyChannel(
  store: StickyStore | undefined,
  key: string,
): Promise<number | null> {
  if (store == null) return null;
  try {
    return await store.get(key);
  } catch {
    return null;
  }
}

/** 解析请求的粘滞上下文（指纹 + 命中渠道；候选循环每轮入口调用一次） */
export async function resolveStickyContext(
  store: StickyStore | undefined,
  input: StickyFingerprintInput,
  prefixChars: number,
): Promise<{ key: string; channelId: number | null }> {
  const key = stickyKeyOf(input, prefixChars);
  return { key, channelId: await resolveStickyChannel(store, key) };
}

/** 成功结算后记录/续期粘滞（fire-and-forget 面：调用方不 await） */
export async function recordSticky(input: {
  store: StickyStore | undefined;
  key: string;
  channelId: number;
  policy: RoutingPolicy;
}): Promise<void> {
  const { store, key, channelId, policy } = input;
  if (store == null || !policy.scorers.cacheAffinity.enabled) return;
  try {
    await store.set(key, channelId, policy.scorers.cacheAffinity.ttlMs);
  } catch {
    // fail-open：粘滞是偏好不是事实源
  }
}
