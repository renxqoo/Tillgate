/**
 * 支付能力装配件（assembly 拆件——铁律 22 文件行数收口）。
 * 当前形态：env 静态注入（与迁移前行为一致）；Phase 7 换集成设置快照动态源
 * + 验签双读窗（docs/integration-settings/DESIGN.md §5 D6/§7）。
 */
import { createPaymentsApi, type Billing, type PaymentsApi } from '@tillgate/billing';
import {
  createEpayProvider,
  createStripeProvider,
  createPostgresPaymentOrderStore,
} from '@tillgate/billing/composition';
import type { Db } from '@tillgate/db';
import type { Logger } from '@tillgate/runtime';
import type { ClientApiConfig } from '../config.js';
import type { FixedWindowCounter } from './redis-rate-counter.js';

export function createClientPayments(args: {
  readonly config: ClientApiConfig;
  readonly db: Db;
  readonly store: Parameters<typeof createPaymentsApi>[0]['store'];
  readonly wallet: Billing['wallet'];
  readonly orderLimiter: FixedWindowCounter;
  readonly logger: Logger;
  readonly clock: () => Date;
}): PaymentsApi {
  const { config, db, wallet, logger, clock } = args;
  return createPaymentsApi({
    store: args.store,
    orders: createPostgresPaymentOrderStore(db),
    wallet,
    providers: envProviders(config),
    currency: config.CLIENT_CURRENCY,
    exchangeRate: config.TOPUP_EXCHANGE_RATE,
    topupMin: config.TOPUP_MIN,
    topupMax: config.TOPUP_MAX,
    orderLimiter: args.orderLimiter,
    perMinuteOrderLimit: config.CLIENT_TOPUP_ORDERS_PER_MINUTE,
    orderTtlMs: config.PAYMENT_ORDER_TTL_MS,
    clock,
    logError: (message, detail) => logger.error({ detail }, message),
  });
}

/** env 在场判定的 provider 数组（assertGroup 已保证组内齐全——非空断言安全） */
function envProviders(config: ClientApiConfig) {
  return [
    ...(config.EPAY_PID != null
      ? [
          createEpayProvider({
            pid: config.EPAY_PID,
            key: config.EPAY_KEY as string,
            gatewayUrl: config.EPAY_GATEWAY_URL as string,
            notifyUrl: config.EPAY_NOTIFY_URL as string,
            returnUrl: config.EPAY_RETURN_URL as string,
            payType: config.EPAY_PAY_TYPE as 'alipay' | 'wxpay' | 'qqpay',
          }),
        ]
      : []),
    ...(config.STRIPE_SECRET_KEY != null
      ? [
          createStripeProvider({
            secretKey: config.STRIPE_SECRET_KEY,
            webhookSecret: config.STRIPE_WEBHOOK_SECRET as string,
            successUrl: config.STRIPE_SUCCESS_URL as string,
            cancelUrl: config.STRIPE_CANCEL_URL as string,
            currency: config.CLIENT_CURRENCY,
            ...(config.STRIPE_API_BASE != null ? { apiBase: config.STRIPE_API_BASE } : {}),
          }),
        ]
      : []),
  ];
}
