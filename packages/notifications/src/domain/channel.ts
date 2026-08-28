/**
 * 通知渠道形状规则(纯函数):类型词表、config 形状、订阅词表、掩码与加密侧归一。
 * 校验口径:
 *  - config 形状独立于 type 校验(url+secret 或 recipients 非空);
 *  - type 在场时再按类型跨校验(webhook→url+secret / email→recipients);
 *  - wire 级细则(url ≤255/secret 16..255/recipients ≤20/邮箱格式)归 admin-api 契约,
 *    本层只承结构性形状。
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

/** name 门:在场才校验(非空 string 且 ≤64) */
function nameError(name: unknown): ChannelShapeError | null {
  if (name === undefined) return null;
  const ok = typeof name === 'string' && name.length > 0 && name.length <= 64;
  return ok ? null : 'name';
}

/** status 门:在场才校验(0/1 整数) */
function statusError(status: unknown): ChannelShapeError | null {
  if (status === undefined) return null;
  const ok = typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 1;
  return ok ? null : 'status';
}

/** events 门:在场才校验(非空数组 + 词表成员) */
function eventsError(events: unknown): ChannelShapeError | null {
  if (events === undefined) return null;
  if (!Array.isArray(events) || events.length === 0) return 'events_empty';
  for (const event of events) {
    if (typeof event !== 'string' || !isNotifyEvent(event)) return 'event_word';
  }
  return null;
}

/** config 门:结构性形状(url+secret 对或非空 recipients)+ type 在场时的跨校验 */
function configError(config: unknown, type: unknown): ChannelShapeError | null {
  if (config === undefined) return null;
  const shape = config as ChannelConfigShape;
  if (shape == null || typeof shape !== 'object' || Array.isArray(shape)) return 'config';
  const hasWebhookPair =
    typeof shape.url === 'string' &&
    shape.url !== '' &&
    typeof shape.secret === 'string' &&
    shape.secret !== '';
  const hasRecipients = Array.isArray(shape.recipients) && shape.recipients.length > 0;
  if (!hasWebhookPair && !hasRecipients) return 'config';
  if (type === 'webhook' && !hasWebhookPair) return 'config';
  if (type === 'email' && !hasRecipients) return 'config';
  return null;
}

/**
 * 结构校验:返回首个违规项,null = 通过(字段序:name → status → events → type → config)。
 * 类型收窄为「字段在场才校验」——PATCH 部分更新语义(type 缺席不触发跨校验)。
 */
export function validateChannelShape(input: ChannelShapeInput): ChannelShapeError | null {
  return (
    nameError(input.name) ??
    statusError(input.status) ??
    eventsError(input.events) ??
    (input.type !== undefined && !isChannelType(input.type) ? 'type' : null) ??
    configError(input.config, input.type)
  );
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
 * 写入侧加密归一:客户端提交的 secret 一律当明文加密(禁止伪装内部 enc:* 密文);
 * 空字符串/缺席原样返回(config 整体替换口径,PUT 语义)。
 */
export function encryptChannelConfig(
  config: Record<string, unknown> | undefined,
  cipher: { encrypt(plaintext: string): string },
): Record<string, unknown> | undefined {
  if (config == null || typeof config.secret !== 'string' || config.secret === '') return config;
  return { ...config, secret: cipher.encrypt(config.secret) };
}
