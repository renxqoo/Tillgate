/**
 * 机制链共享小件：事件分发（快照迭代）/ 渠道维 key / 前置校验（从 create-ai 拆出的无状态纯件）。
 */
import type { AiEvent } from '../events';

/**
 * 事件分发：同步、逐监听者、异常隔离（观察者异常不反噬数据面）。
 * 快照迭代：分发过程中退订（splice）不跳过后续监听者——修复 v1 竞态。
 * 契约：回调必须微秒级、无 IO（重活入队）；fire-and-forget，无背压（保护数据面）。
 */
export function emitTo(listeners: ReadonlyArray<(e: AiEvent) => void>, e: AiEvent): void {
  // slice() 快照：分发过程中退订（原数组 splice）不跳过后续监听者——修复 v1 竞态
  for (const l of listeners.slice()) {
    try {
      l(e);
    } catch {
      /* 观察者异常不破坏管道 */
    }
  }
}

/**
 * 渠道维 key（事件维度单一真相，protocol://host）：
 * 订阅者（渠道健康计数）以此分桶；与 requestId（调用维度）正交。
 */
export function channelKey(channel: { protocol: string; baseUrl: string }): string {
  try {
    return `${channel.protocol}://${new URL(channel.baseUrl).host}`;
  } catch {
    return `${channel.protocol}://unknown`;
  }
}

/**
 * 渠道配置校验（fail fast）：apiKey/baseUrl/protocol 必需且非空——
 * 空 key 会拼出无效 Authorization、错误信息不清晰，不发垃圾请求。
 */
export function assertChannel(channel: { apiKey: string; baseUrl: string; protocol: string }): string | null {
  if (!channel.apiKey) return 'channel.apiKey 为空';
  if (!channel.baseUrl) return 'channel.baseUrl 为空';
  if (!channel.protocol) return 'channel.protocol 为空';
  return null;
}
