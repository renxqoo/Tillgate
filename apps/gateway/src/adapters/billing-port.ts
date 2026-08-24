/**
 * inference BillingPort 的生产实现（DESIGN C-G3，装配面专属）：
 * 包一层 @tillgate/billing facade 的 authorize/signal/reserveChannel 三用例——
 *   authorize：inference 候选链 → BillingQuote（inputTokenUpperBound 逐候选盖章、
 *     explicitlyFree = 候选链全免费）；reservationLimit/Policy 由 gateway config 持有；
 *   signal：蛇形词表 → billing 点分词表 + 收据字段结构对齐（两包同源 v1 receipt）；
 *   reserveChannel：官方价口径（coefficient=1）estimateMaxCost 自算 amount（进货
 *     额度闸的预估敞口，与用户计价系数无关）。
 * 零金额运算实现——公式全部在 billing 域（单一真相）。
 */
import {
  estimateMaxCost,
  type BillingEvent,
  type BillingQuote,
  type BillingQuoteCandidate,
} from '@tillgate/billing';
import type {
  BillingPort,
  BillingSignal,
  QuoteCandidate,
  UsageReceipt,
} from '@tillgate/inference';

export interface GatewayBillingConfig {
  reservationLimit: string;
  reservationPolicy: { mode: 'full' } | { mode: 'fixed'; amount: string };
  /** 结算积压准入（bridge 级调用：authorize 前置闸；R-E4——requestId 恒服务端生成，
   *  HTTP 面无客户端重放路径，桥级 admission 不破坏 billing 内部的重放免疫） */
  assertCapacity?: () => Promise<void>;
}

export interface GatewayBillingApi {
  authorize(input: {
    requestId: string;
    userId: number;
    apiKeyId?: number | null;
    appId?: number | null;
    stream: boolean;
    quote: BillingQuote;
    reservationLimit: string;
    reservationPolicy?: { mode?: 'full' | 'fixed'; amount?: string };
    authorizationTtlMs: number;
  }): Promise<unknown>;
  signal(event: BillingEvent): Promise<unknown>;
  reserveChannel(input: {
    requestId: string;
    channelId: number;
    amount: string;
  }): Promise<{ allowed: boolean; remaining: string; switched: boolean }>;
}

const allPricesZero = (c: QuoteCandidate): boolean =>
  [
    c.inputPrice,
    c.cacheInputPrice,
    c.cacheWritePrice ?? '0',
    c.outputPrice,
    c.unitPrice ?? '0',
  ].every((p) => Number(p) === 0);

/** inference 候选 → billing 报价候选（字段同源；inputUpperBound 逐候选盖章） */
function toQuoteCandidate(c: QuoteCandidate, inputTokenUpperBound: number): BillingQuoteCandidate {
  return {
    mappingId: c.mappingId,
    externalModel: c.externalModel,
    realModel: c.realModel,
    inputPrice: c.inputPrice,
    outputPrice: c.outputPrice,
    cacheInputPrice: c.cacheInputPrice,
    ...(c.cacheWritePrice != null ? { cacheWritePrice: c.cacheWritePrice } : {}),
    ...(c.unitPrice != null ? { unitPrice: c.unitPrice } : {}),
    coefficient: c.coefficient,
    inputTokenUpperBound,
    pricingUnit: c.pricingUnit,
    unitUpperBound: c.unitUpperBound,
    billingPolicyFingerprint: c.billingPolicyFingerprint,
    ...(c.pricingWindow != null ? { pricingWindow: c.pricingWindow } : {}),
  };
}

export function createGatewayBilling(
  api: GatewayBillingApi,
  config: GatewayBillingConfig,
): BillingPort {
  return {
    async authorize(input) {
      if (config.assertCapacity != null) await config.assertCapacity();
      const quote: BillingQuote = {
        maxOutputTokens: input.maxOutputTokens,
        candidates: input.candidates.map((c) => toQuoteCandidate(c, input.inputTokenUpperBound)),
        // 显式免费 = 候选链全免费（v1 chain.every(isFree)；billing R6 结构性校验兜底）
        ...(input.candidates.every((c) => c.isFree === true || allPricesZero(c))
          ? { explicitlyFree: true }
          : {}),
      };
      await api.authorize({
        requestId: input.requestId,
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        appId: input.appId,
        stream: input.stream,
        quote,
        reservationLimit: config.reservationLimit,
        ...(config.reservationPolicy.mode === 'fixed'
          ? { reservationPolicy: { mode: 'fixed', amount: config.reservationPolicy.amount } }
          : {}),
        authorizationTtlMs: input.authorizationTtlMs,
      });
    },

    async signal(signal: BillingSignal) {
      switch (signal.type) {
        case 'upstream_started':
          await api.signal({
            type: 'upstream.started',
            requestId: signal.requestId,
            leaseOwner: signal.leaseOwner,
            leaseMs: signal.leaseMs,
          });
          return;
        case 'lease_renewed':
          await api.signal({
            type: 'lease.renewed',
            requestId: signal.requestId,
            leaseOwner: signal.leaseOwner,
            leaseMs: signal.leaseMs,
          });
          return;
        case 'request_succeeded':
          await api.signal({
            type: 'request.succeeded',
            requestId: signal.requestId,
            // 收据两包同源（v1 receipt 迁移 twin）——结构直传
            receipt: signal.receipt as unknown as BillingEvent extends { receipt: infer R }
              ? R
              : never,
          });
          return;
        case 'request_failed':
          await api.signal({
            type: 'request.failed',
            requestId: signal.requestId,
            reason: signal.reason,
          });
          return;
      }
    },

    async reserveChannel(input) {
      const c = input.candidate;
      // 官方价口径（coefficient=1）：渠道进货额度闸衡量上游成本，与用户费率卡无关
      const amount = estimateMaxCost({
        estimatedInputTokens: input.estimatedInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        inputPrice: c.inputPrice,
        cacheInputPrice: c.cacheInputPrice,
        cacheWritePrice: c.cacheWritePrice ?? undefined,
        outputPrice: c.outputPrice,
        unitPrice: c.unitPrice ?? '0',
        unitUpperBound: c.unitUpperBound,
        coefficient: '1',
      }).toString();
      const result = await api.reserveChannel({
        requestId: input.requestId,
        channelId: input.channelId,
        amount,
      });
      return { allowed: result.allowed } as { allowed: true } | { allowed: false };
    },
  };
}

export type { UsageReceipt };
