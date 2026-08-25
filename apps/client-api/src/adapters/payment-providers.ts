/**
 * 支付能力装配件（动态形态——docs/integration-settings/DESIGN.md §5 D6/D7）。
 * 下单面：wrapper.accepting 按快照 effective 求值（resolveProvider/channels 过滤），
 * createOrder 再以严格读复核；验签面：complete 即可用（停用不停验签——在途订单
 * 回调不因渠道停用而拒收），密钥序列先新后旧（轮换双读窗）。
 */
import {
  BillingErrors,
  EPAY_PAY_TYPES,
  createPaymentsApi,
  type Billing,
  type PaymentsApi,
  type PaymentProviderPort,
} from '@tillgate/billing';
import {
  createEpayProvider,
  createStripeProvider,
  createPostgresPaymentOrderStore,
} from '@tillgate/billing/composition';
import type { IntegrationSettingsReader } from '@tillgate/control-plane';
import type { Db } from '@tillgate/db';
import type { Logger } from '@tillgate/runtime';
import type { ClientApiConfig } from '../config.js';
import type { FixedWindowCounter } from './redis-rate-counter.js';

export function createClientPayments(args: {
  readonly config: ClientApiConfig;
  readonly db: Db;
  readonly reader: IntegrationSettingsReader;
  readonly store: Parameters<typeof createPaymentsApi>[0]['store'];
  readonly wallet: Billing['wallet'];
  readonly orderLimiter: FixedWindowCounter;
  readonly logger: Logger;
  readonly clock: () => Date;
}): PaymentsApi {
  const { config, db, wallet, logger, clock, reader } = args;
  return createPaymentsApi({
    store: args.store,
    orders: createPostgresPaymentOrderStore(db),
    wallet,
    providers: [dynamicEpayProvider(reader), dynamicStripeProvider(reader, config.CLIENT_CURRENCY)],
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

/** 易支付动态包装：下单看 effective（严格读复核）；验签看 complete + 双读窗 */
function dynamicEpayProvider(reader: IntegrationSettingsReader): PaymentProviderPort {
  return {
    name: 'epay',
    accepting: () => {
      const { epay } = reader.latest().payments;
      return epay.effective && payTypeOf(epay.config?.payType) != null;
    },
    async createOrder(input) {
      const { epay } = (await reader.resolve()).payments;
      const cfg = epay.config;
      const payType = payTypeOf(cfg?.payType);
      if (cfg == null || !epay.effective || payType == null) {
        throw BillingErrors.business('payment_unavailable', { provider: 'epay' });
      }
      return createEpayProvider({
        pid: cfg.pid,
        key: cfg.key,
        gatewayUrl: cfg.gatewayUrl,
        notifyUrl: cfg.notifyUrl,
        returnUrl: cfg.returnUrl,
        payType,
      }).createOrder(input);
    },
    parseNotify(raw) {
      const cfg = reader.latest().payments.epay.config;
      const payType = payTypeOf(cfg?.payType);
      if (cfg == null || payType == null) return null;
      return createEpayProvider({
        pid: cfg.pid,
        key: cfg.key,
        gatewayUrl: cfg.gatewayUrl,
        notifyUrl: cfg.notifyUrl,
        returnUrl: cfg.returnUrl,
        payType,
        verifyKeys: cfg.verifyKeys,
      }).parseNotify(raw);
    },
  };
}

/** Stripe 动态包装：同上口径；webhookSecrets 携双读窗序列（先新后旧） */
function dynamicStripeProvider(
  reader: IntegrationSettingsReader,
  currency: string,
): PaymentProviderPort {
  return {
    name: 'stripe',
    accepting: () => reader.latest().payments.stripe.effective,
    async createOrder(input) {
      const { stripe } = (await reader.resolve()).payments;
      const cfg = stripe.config;
      if (cfg == null || !stripe.effective) {
        throw BillingErrors.business('payment_unavailable', { provider: 'stripe' });
      }
      return createStripeProvider({
        secretKey: cfg.secretKey,
        webhookSecret: cfg.webhookSecret,
        webhookSecrets: cfg.webhookSecrets,
        successUrl: cfg.successUrl,
        cancelUrl: cfg.cancelUrl,
        currency,
        ...(cfg.apiBase != null ? { apiBase: cfg.apiBase } : {}),
      }).createOrder(input);
    },
    parseNotify(raw) {
      const cfg = reader.latest().payments.stripe.config;
      if (cfg == null) return null;
      return createStripeProvider({
        secretKey: cfg.secretKey,
        webhookSecret: cfg.webhookSecret,
        webhookSecrets: cfg.webhookSecrets,
        successUrl: cfg.successUrl,
        cancelUrl: cfg.cancelUrl,
        currency,
        ...(cfg.apiBase != null ? { apiBase: cfg.apiBase } : {}),
      }).parseNotify(raw);
    },
  };
}

/** 支付类型词表防御（写入/导入双闸后的最后一道——非法存量值按未配置处理） */
function payTypeOf(value: string | undefined): (typeof EPAY_PAY_TYPES)[number] | null {
  if (value == null) return 'alipay';
  return (EPAY_PAY_TYPES as readonly string[]).includes(value)
    ? (value as (typeof EPAY_PAY_TYPES)[number])
    : null;
}
