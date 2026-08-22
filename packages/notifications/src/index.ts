/**
 * @tokenlens/notifications 公共出口:通知能力(渠道 CRUD、事务 outbox 入箱/认领/投递、模板)。
 * 出口面刻意极小且由 __test__/architecture.test.ts 锁定——只暴露 facade、用例出入参、
 * 领域词表与纯函数、错误目录;store/适配器/drizzle 行类型/Db/DbTx 不出包(§5.3)。
 */

// ---- facade ----
export { createNotifications } from './notifications';
export type { Notifications, CreateNotificationsParams } from './notifications';

// ---- 调用上下文 ----
export type { NotifyActor, NotifyContext } from './application/context';
export { systemContext } from './application/context';

// ---- 错误目录(AGENT.md §11:码表封闭性由测试锁定)----
export { notificationsErrors } from './errors';

// ---- 领域词表与纯函数 ----
export { NOTIFY_EVENTS, isNotifyEvent } from './domain/events';
export type { NotifyEvent } from './domain/events';
export {
  CHANNEL_TYPES,
  maskSecret,
  maskChannelConfig,
  encryptChannelConfig,
  validateChannelShape,
} from './domain/channel';
export type { ChannelType, NotificationChannel, ChannelShapeError } from './domain/channel';
export {
  backoffDelayMs,
  signWebhook,
  webhookBody,
  webhookHeaders,
  selectTargetChannels,
  succeededChannelIds,
} from './domain/delivery';
export type { WebhookHeaders } from './domain/delivery';
export { renderAlertEmail } from './templates/alert-email';
export type { AlertEmail } from './templates/alert-email';

// ---- 装配/桥接 port 契约(assembly 注入实现)----
export type { EmailSender } from './ports/email-sender';
export type { WebhookDeliverer, WebhookDeliveryInput } from './ports/webhook-deliverer';
export type { SecretCipher } from './ports/secret-cipher';
export type { UrlGuard } from './ports/url-guard';

// ---- 用例出入参(app 路由层/装配契约)----
export type {
  DispatchConfig,
  DispatchOnceInput,
  DispatchResult,
} from './application/dispatch-once';
export type { EnqueueInput } from './application/enqueue';
export type { MaskedChannel } from './application/list-channels';
export type { CreateChannelInput } from './application/create-channel';
export type { PatchChannelInput } from './application/patch-channel';
export type { RemoveChannelInput } from './application/remove-channel';
export type { TestChannelInput } from './application/test-channel';
