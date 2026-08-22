/**
 * 通知渠道形状规则(纯函数):类型词表、config 形状、订阅词表、掩码与加密侧归一。
 * 校验口径 = v1 路由 zod + 服务层 assertChannelInput 的合并收口(B1):
 *  - config 形状独立于 type 校验(url+secret 或 recipients 非空——zod refine 语义);
 *  - type 在场时再按类型跨校验(webhook→url+secret / email→recipients,服务层语义);
 *  - wire 级细则(url ≤255/secret 16..255/recipients ≤20/邮箱格式)归 admin-api 契约,
 *    本层只承结构性形状(IMPLEMENTATION §1.3)。
 */
import { isNotifyEvent, type NotifyEvent } from './events';

export const CHANNEL_TYPES = ['webhook', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export interface ChannelConfigShape {
  readonly url?: string;
  readonly secret?: string;
  readonly recipients?: readonly string[];
}

export interface ChannelShapeInput {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly config?: unknown;
  readonly events?: unknown;
  readonly status?: unknown;
}

export type ChannelShapeError =
  | 'name'
  | 'type'
  | 'config'
  | 'events'
  | 'events_empty'
  | 'event_word'
  | 'status';

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && (CHANNEL_TYPES as readonly string[]).includes(value);
}

/**
 * 结构校验:返回首个违规项,null = 通过。
 * 类型收窄为「字段在场才校验」——PATCH 部分更新语义(type 缺席不触发跨校验,v1 语义)。
 */
export function validateChannelShape(input: ChannelShapeInput): ChannelShapeError | null {
  if (
    input.name !== undefined &&
    !(typeof input.name === 'string' && input.name.length >= 1 && input.name.length <= 64)
  ) {
    return 'name';
  }
  if (
    input.status !== undefined &&
    !(
      typeof input.status === 'number' &&
      Number.isInteger(input.status) &&
      input.status >= 0 &&
      input.status <= 1
    )
  ) {
    return 'status';
  }
  if (input.events !== undefined) {
    if (!Array.isArray(input.events) || input.events.length === 0) return 'events_empty';
    for (const event of input.events) {
      if (typeof event !== 'string' || !isNotifyEvent(event)) return 'event_word';
    }
  }
  if (input.type !== undefined && !isChannelType(input.type)) return 'type';
  if (input.config !== undefined) {
    const config = input.config as ChannelConfigShape;
    if (config == null || typeof config !== 'object' || Array.isArray(config)) return 'config';
    const hasWebhookPair =
      typeof config.url === 'string' &&
      config.url !== '' &&
      typeof config.secret === 'string' &&
      config.secret !== '';
    const hasRecipients = Array.isArray(config.recipients) && config.recipients.length > 0;
    if (!hasWebhookPair && !hasRecipients) return 'config';
    if (input.type === 'webhook' && !hasWebhookPair) return 'config';
    if (input.type === 'email' && !hasRecipients) return 'config';
  }
  return null;
}

/** 渠道订阅事件的词表收窄(落库行 events → NotifyEvent[];非词表成员丢弃——行来源必经校验) */
export function narrowEvents(events: readonly string[]): NotifyEvent[] {
  return events.filter(isNotifyEvent);
}

/** 渠道记录形状(存储无关;ports/adapters 消费——config 为落库形态,secret 可能是密文) */
export interface NotificationChannel {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly config: Record<string, unknown>;
  readonly events: NotifyEvent[];
  readonly status: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 密钥掩码:保留尾 4 位(掩的是密文——可辨认不可复用;空值全遮) */
export function maskSecret(secret: string): string {
  if (!secret) return '****';
  return `****${secret.slice(-4)}`;
}

/** 列表/返回侧掩码:config 含 secret 键时替换为掩码(密文不回显,防二次扩散) */
export function maskChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.secret !== 'string') return config;
  return { ...config, secret: maskSecret(config.secret) };
}

/**
 * 写入侧加密归一:客户端提交的 secret 一律当明文加密(禁止伪装内部 enc:* 密文——
 * v1 语义);空字符串/缺席原样返回(config 整体替换口径,PUT 语义)。
 */
export function encryptChannelConfig(
  config: Record<string, unknown> | undefined,
  cipher: { encrypt(plaintext: string): string },
): Record<string, unknown> | undefined {
  if (config == null || typeof config.secret !== 'string' || config.secret === '') return config;
  return { ...config, secret: cipher.encrypt(config.secret) };
}
