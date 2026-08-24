/**
 * 充值支付用例（迁移自旧仓 client-api payments.service——从 app 下沉到能力包）：
 * 下单（面额闸 → 渠道解析 → 先落库再调渠道）+ 回调入账（验签 → 金额核对 →
 * 单事务 markPaid→credit→markCredited）+ 订单列表（机会式关单，只关自己的单）。
 *
 * 资损不变量：
 *   - creditAmount 创建时定死（amount × 汇率），回调只认订单不重算
 *   - 验签证来源、金额核对防篡改（签名合法 ≠ 金额合法——两道独立闸）
 *   - paid→credited 与入账同一事务：崩溃时订单停留 created/paid，渠道重发回调重放
 *   - 入账幂等锚 refType='topup' + refId=orderId：重复回调结构性只入一次
 *   - 先落 DB 行再调渠道：反序会留下「可支付但无 DB 行」的资金黑洞
 *   - 过期单复活：过期只是关单标记非资金事实——已验签金额一致即收尾入账
 */
import { randomUUID } from 'node:crypto';
import { BillingErrors } from '../../domain/errors.js';
import {
  amountsMatch,
  assertTopupWithinLimit,
  computeCreditAmount,
} from '../../domain/payment/topup.js';
import type {
  PaymentOrderStore,
  PaymentProviderPort,
  RateCounterPort,
} from '../../ports/payment-ports.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { PaymentOrderRow } from '../../ports/payment-ports.js';
import type { WalletApi } from '../wallet/wallet.js';

export const PROVIDER_LABELS: Record<'epay' | 'stripe', string> = {
  epay: '支付宝/微信（易支付）',
  stripe: 'Stripe',
};

export interface PaymentsDeps {
  store: BillingStore;
  orders: PaymentOrderStore;
  wallet: WalletApi;
  /** 启用的渠道（至少一个） */
  providers: readonly PaymentProviderPort[];
  currency: string;
  /** 入账汇率（amount × rate = creditAmount；装配必填） */
  exchangeRate: string;
  topupMin: string;
  topupMax: string;
  /** 下单频率闸（可选注入；不可达时 fail-closed 拒单） */
  orderLimiter?: RateCounterPort;
  /** 每分钟下单上限（装配必填——配合 orderLimiter 生效；不写死缺省） */
  perMinuteOrderLimit: number;
  orderTtlMs: number;
  /** 时钟（装配必填——零写死；DB 时钟权威路径不经此） */
  clock: () => Date;
  /**
   * 运营/审计异常写入（装配必填：logger/遥测注入——console 直写是隐藏 I/O，
   * 铁律 3）。承载渠道下单失败回填、回调金额错配、入账失败等资金留痕事件。
   */
  logError: (message: string, detail?: unknown) => void;
}

export interface PaymentsApi {
  createTopupOrder(
    userId: number,
    input: { amount: string; provider?: 'epay' | 'stripe' },
  ): Promise<{ orderId: string; payUrl: string; creditAmount: string }>;
  /** 回调处理：返回 'success' | 'fail'（渠道重发语义） */
  handleNotify(providerName: string, raw: Record<string, string>): Promise<'success' | 'fail'>;
  orderDetail(userId: number, orderId: string): Promise<PaymentOrderRow>;
  listOrders(userId: number, input: { page: number; limit: number }): Promise<PaymentOrderRow[]>;
  channels(): Array<{ id: string; label: string }>;
}

// eslint-disable-next-line max-lines-per-function -- 支付编排:渠道选择/订单生命周期顺序步骤
export function createPaymentsApi(deps: PaymentsDeps): PaymentsApi {
  const { store, orders, wallet } = deps;
  const { clock } = deps;
  const byName = new Map(deps.providers.map((p) => [p.name, p]));

  /** 渠道解析：显式指定须命中；未指定时唯一渠道直通，多渠道须显式选择 */
  const resolveProvider = (requested?: 'epay' | 'stripe'): PaymentProviderPort => {
    if (requested) {
      const found = byName.get(requested);
      if (!found) {
        throw BillingErrors.business('payment_unavailable', { provider: requested });
      }
      return found;
    }
    const [only] = deps.providers;
    if (deps.providers.length === 1 && only !== undefined) return only;
    throw BillingErrors.business('payment_unavailable', {});
  };

  return {
    // eslint-disable-next-line max-lines-per-function -- 支付编排:webhook 回放锚与订单定位顺序步骤
    async createTopupOrder(userId, input) {
      if (deps.orderLimiter) {
        let n: number;
        try {
          n = await deps.orderLimiter.hit(`topup-order:${userId}`, 60);
        } catch {
          throw BillingErrors.business('rate_counter_unavailable', { action: 'topup-order' });
        }
        if (n > deps.perMinuteOrderLimit) {
          throw BillingErrors.business('topup_rate_limited', { userId });
        }
      }
      assertTopupWithinLimit(input.amount, deps.topupMin, deps.topupMax);
      const provider = resolveProvider(input.provider);
      const creditAmount = computeCreditAmount(input.amount, deps.exchangeRate);
      const orderId = randomUUID();
      // 先落 DB 行再调渠道：渠道成功与落库之间的崩溃会留下
      // 「可支付但无 DB 行」的渠道会话 = 无法对账的资金黑洞；反过来渠道失败
      // 只是本地一行 status=0 订单（由 TTL 关单自然回收）
      await store.transaction((tx) =>
        orders.insertOrder(tx, {
          id: orderId,
          provider: provider.name,
          providerOrderId: orderId, // 占位：epay 即终值；Stripe 建会话后回填
          userId,
          amount: input.amount,
          currency: deps.currency,
          creditAmount,
        }),
      );
      let channel: { providerOrderId: string; payUrl: string };
      try {
        channel = await provider.createOrder({
          orderId,
          amount: input.amount,
          subject: '余额充值',
        });
      } catch (error) {
        // 渠道下单失败：关单留痕——渠道侧确定性失败即刻可见
        deps.logError(`[billing] payment channel create failed order=${orderId}`, error);
        await store.transaction((tx) => orders.markChannelFailed(tx, orderId)).catch(() => {});
        throw BillingErrors.business('payment_channel_unavailable', { orderId });
      }
      // 渠道会话已建立：回填真实渠道单号（Stripe session id；epay 与占位相同无操作）。
      // 回填是回调定位锚——失败必须大声（静默吞 = webhook 永远找不到订单 = 已付款搁浅）
      if (channel.providerOrderId !== orderId) {
        await store
          .transaction((tx) =>
            orders.attachProviderOrderId(tx, { orderId, providerOrderId: channel.providerOrderId }),
          )
          .catch((error) => {
            deps.logError(
              `[billing] attach provider order id failed order=${orderId} channel=${channel.providerOrderId}`,
              error,
            );
          });
      }
      return { orderId, payUrl: channel.payUrl, creditAmount };
    },

    // eslint-disable-next-line max-lines-per-function -- 支付编排:webhook 幂等核对事务体
    async handleNotify(providerName, raw) {
      const provider = byName.get(providerName as 'epay' | 'stripe');
      if (!provider) return 'fail';
      const parsed = provider.parseNotify(raw);
      if (!parsed) return 'fail';

      let order = await store.read((conn) =>
        orders.findByProviderOrderId(conn, {
          provider: providerName,
          providerOrderId: parsed.providerOrderId,
        }),
      );
      const { merchantOrderId } = parsed;
      if (!order && merchantOrderId) {
        // 回退锚：渠道会话号回填失败/竞态未达时按商户订单号定位
        // （没有它 Stripe webhook 在 attach 缺席时永远找不到订单 = 已付款搁浅）
        const byMerchant = await store.read((conn) => orders.findById(conn, merchantOrderId));
        if (
          byMerchant?.provider === providerName &&
          // 仅允许「真实渠道单号尚未回填」的占位订单走商户单号回退。
          // 已绑定另一个 session 时继续回退会把一笔合法 Stripe 付款错记到别人的订单。
          (byMerchant.providerOrderId === byMerchant.id ||
            byMerchant.providerOrderId === parsed.providerOrderId)
        ) {
          order = byMerchant;
        }
      }
      if (!order) return 'fail';
      // 金额核对：签名只证来源，金额才防「少付多得」（按订单实付比对，全精度）
      if (!amountsMatch(parsed.paidAmount, order.amount)) {
        deps.logError('[billing] payment notify amount mismatch', { orderId: order.id });
        return 'fail';
      }
      // 已入账：重复回调幂等成功应答（渠道停止重发）
      if (order.status === 2) return 'success';

      try {
        await store.transaction(async (tx) => {
          const paid = await orders.markPaid(tx, { orderId: order.id, paidAt: clock() });
          if (!paid) {
            // 并发回调/乱序跃迁：重读定夺（credited 幂等成功；paid 遗留单继续收尾入账）
            let fresh = await orders.findById(tx, order.id);
            if (fresh == null) {
              throw BillingErrors.business('order_state_conflict', { orderId: order.id });
            }
            if (fresh.status === 2) return;
            if (fresh.status === 4) {
              // 过期单 + 已验签 + 金额一致 = 用户已付款（过期只是关单标记，非资金事实）——
              // 复活收尾入账；不复活即「扣了钱不记账」的搁浅单（无自动对账路径）
              const revived = await orders.reviveExpiredAsPaid(tx, {
                orderId: order.id,
                paidAt: clock(),
              });
              if (revived) {
                fresh = await orders.findById(tx, order.id);
              }
            }
            if (fresh == null || fresh.status !== 1) {
              throw BillingErrors.business('order_state_conflict', { orderId: order.id });
            }
          }
          await wallet.credit({
            userId: order.userId,
            amount: order.creditAmount,
            refType: 'topup',
            refId: order.id,
            memo: `在线充值入账（${order.provider} ${order.amount} ${order.currency}）`,
            tx,
          });
          const done = await orders.markCredited(tx, { orderId: order.id, creditedAt: clock() });
          if (!done) {
            throw BillingErrors.business('order_state_conflict', { orderId: order.id });
          }
        });
        return 'success';
      } catch (error) {
        // 入账失败：订单停留 created/paid（可重试）——渠道按应答重发回调；
        // 写入注入留痕（装配必填），静默吞 = 已付款搁浅不可见
        deps.logError('[billing] payment credit failed (order stays retryable)', error);
        return 'fail';
      }
    },

    async orderDetail(userId, orderId) {
      const row = await store.read((conn) => orders.findByUserAndId(conn, { userId, orderId }));
      if (!row) throw BillingErrors.business('order_not_found', { orderId });
      return row;
    },

    async listOrders(userId, input) {
      // 机会式关单：未支付且超 TTL 的订单置 expired。只关自己的单——全局关单会把
      // 他人支付中的订单误关，制造「已付款被拒收」搁浅单。空 catch 是有意为之：
      // 关单是读路径顺带的 best-effort 优化（失败只影响本页展示口径，不影响资金
      // 事实——expired 非资金状态，已付款单可经回调复活收尾）；不得阻断订单列表。
      try {
        await store.transaction((tx) =>
          orders.expireOverdue(tx, {
            userId,
            createdBefore: new Date(clock().getTime() - deps.orderTtlMs),
          }),
        );
      } catch {
        /* 机会式 */
      }
      return store.read((conn) =>
        orders.listByUser(conn, {
          userId,
          limit: input.limit,
          offset: (input.page - 1) * input.limit,
        }),
      );
    },

    channels() {
      return deps.providers.map((p) => ({ id: p.name, label: PROVIDER_LABELS[p.name] }));
    },
  };
}
