/**
 * 投递机制纯函数:退避公式、webhook 签名/头/体构造、目标渠道筛选。
 * 状态机不变量(claim fencing/终态)由 store 的 SQL 承载,本层只承可测纯计算。
 */
import { createHmac } from 'node:crypto';
import type { NotificationChannel } from './channel';

/** 指数退避:min(cap, base × 2^attempts);attempts 为已失败次数,base/cap 由装配注入 */
export function backoffDelayMs(
  attempts: number,
  limits: { baseMs: number; capMs: number },
): number {
  return Math.min(limits.capMs, limits.baseMs * 2 ** attempts);
}

/** webhook 体:JSON.stringify({event, timestamp, payload})——签名覆盖此字节串 */
export function webhookBody(
  event: string,
  timestamp: number,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ event, timestamp, payload });
}

/** HMAC-SHA256(secret, `${timestamp}.${body}`) → 小写 hex;接收方按此口径验签 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export interface WebhookHeaders {
  readonly 'content-type': string;
  readonly 'x-notify-delivery': string;
  readonly 'x-notify-event': string;
  readonly 'x-notify-timestamp': string;
  readonly 'x-notify-signature': string;
}

export function webhookHeaders(input: {
  deliveryId: string;
  event: string;
  timestamp: number;
  signature: string;
}): WebhookHeaders {
  return {
    'content-type': 'application/json',
    'x-notify-delivery': input.deliveryId,
    'x-notify-event': input.event,
    'x-notify-timestamp': String(input.timestamp),
    'x-notify-signature': input.signature,
  };
}

/**
 * 目标渠道筛选:订阅该事件且尚未成功投递(进度集内跳过——部分失败重试不重发)。
 * 活跃过滤(status=0)由 store.listActive 承载;此处对 status 再设防(快照内不再复查,
 * 防御性恒等)。
 */
export function selectTargetChannels(
  channels: readonly NotificationChannel[],
  input: { event: string; deliveredChannelIds: readonly number[] },
): NotificationChannel[] {
  const delivered = new Set(input.deliveredChannelIds);
  return channels.filter(
    (channel) =>
      channel.status === 0 &&
      (channel.events as readonly string[]).includes(input.event) &&
      !delivered.has(channel.id),
  );
}

/** 并行投递结果 → 成功渠道 id(与 channels 同序索引对齐) */
export function succeededChannelIds(
  channels: readonly NotificationChannel[],
  outcomes: readonly boolean[],
): number[] {
  return channels.filter((_, index) => outcomes[index] === true).map((channel) => channel.id);
}
