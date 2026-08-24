/**
 * createNotifications facade:唯一装配面(总纲 §5.3——app 只见 facade 与稳定契约)。
 * 内部组装 postgres store 与 http webhook deliverer;装配级可覆盖件(store/deliverer,
 * 测试替身注入)显式可选。返回面不泄漏 Db/DbTx/drizzle 行类型/供应商 SDK。
 * SSRF/cipher 经注入 port(UrlGuard/SecretCipher)——本包不编译依赖 ai/runtime(DESIGN §5)。
 */
import type { Db } from '@tillgate/db';
import { postgresNotifyStore } from './adapters/postgres/notify-store';
import { createWebhookDeliverer } from './adapters/webhook/http-deliverer';
import type { NotifyStore } from './ports/notify-store';
import type { EmailSender } from './ports/email-sender';
import type { WebhookDeliverer } from './ports/webhook-deliverer';
import type { SecretCipher } from './ports/secret-cipher';
import type { UrlGuard } from './ports/url-guard';
import { enqueue, type EnqueueInput } from './application/enqueue';
import {
  dispatchOnce,
  type DispatchConfig,
  type DispatchOnceInput,
  type DispatchResult,
} from './application/dispatch-once';
import {
  listChannels,
  type ListChannelsDeps,
  type MaskedChannel,
} from './application/list-channels';
import { createChannel, type CreateChannelInput } from './application/create-channel';
import { patchChannel, type PatchChannelInput } from './application/patch-channel';
import { removeChannel, type RemoveChannelInput } from './application/remove-channel';
import { testChannel, type TestChannelInput } from './application/test-channel';

export interface CreateNotificationsParams {
  readonly db: Db;
  /** 落库加解密(装配注入 runtime.createCipher 产物) */
  readonly cipher: SecretCipher;
  /** SSRF 断言(装配注入 ai.assertSafeUrl 包装) */
  readonly urlGuard: UrlGuard;
  /** 邮件发送(装配注入 smtpSenderFromEnv 产物;缺省 = email 渠道 fail-closed) */
  readonly emailSender?: EmailSender;
  readonly logger: { warn(obj: unknown, msg: string): void };
  /** webhook 逃生门结果值:env 允许且非生产才 true(装配层双门,生产恒 false) */
  readonly webhookAllowLocalUrl: boolean;
  readonly config: DispatchConfig;
  /** 覆盖件(默认门禁测试替身;缺省 postgres/http 真实现) */
  readonly store?: NotifyStore;
  readonly webhookDeliverer?: WebhookDeliverer;
}

export interface Notifications {
  readonly channels: {
    list(): Promise<MaskedChannel[]>;
    create(input: CreateChannelInput): Promise<MaskedChannel>;
    patch(input: PatchChannelInput): Promise<MaskedChannel>;
    remove(input: RemoveChannelInput): Promise<{ ok: true }>;
    test(input: TestChannelInput): Promise<{ ok: true }>;
  };
  /** 入箱(旁路动词;同事务场景走 ./composition bridge) */
  readonly enqueue: (input: EnqueueInput) => Promise<void>;
  readonly dispatchOnce: (input?: DispatchOnceInput) => Promise<DispatchResult>;
}

export function createNotifications(params: CreateNotificationsParams): Notifications {
  const store = params.store ?? postgresNotifyStore;
  const webhookDeliverer =
    params.webhookDeliverer ??
    createWebhookDeliverer({
      guard: params.urlGuard,
      timeoutMs: params.config.webhookTimeoutMs,
      allowLocal: params.webhookAllowLocalUrl,
      logger: params.logger,
    });
  const listDeps: ListChannelsDeps = { db: params.db, store };

  return {
    channels: {
      list: () => listChannels(listDeps),
      create: (input) => createChannel({ db: params.db, store, cipher: params.cipher }, input),
      patch: (input) => patchChannel({ db: params.db, store, cipher: params.cipher }, input),
      remove: (input) => removeChannel({ db: params.db, store }, input),
      test: (input) => testChannel({ db: params.db, store }, input),
    },
    enqueue: (input) => enqueue({ db: params.db, store }, input),
    dispatchOnce: (input) =>
      dispatchOnce(
        {
          db: params.db,
          store,
          cipher: params.cipher,
          ...(params.emailSender !== undefined ? { emailSender: params.emailSender } : {}),
          webhookDeliverer,
          config: params.config,
          logger: params.logger,
        },
        input,
      ),
  };
}
