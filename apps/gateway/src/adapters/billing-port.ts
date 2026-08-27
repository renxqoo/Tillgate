/**
 * inference BillingPort 的生产实现（装配面专属）：
 * 包一层 @tillgate/billing facade 的 authorize/signal/reserveChannel 三用例——
 *   authorize：inference 候选链 → BillingQuote（inputTokenUpperBound 逐候选盖章、
 *     explicitlyFree = 候选链全免费）；reservationLimit/Policy 由 gateway config 持有；
 *   signal：蛇形词表 → billing 点分词表 + 收据字段结构对齐；
 *   reserveChannel：官方价口径（coefficient=1）estimateMaxCost 自算 amount（进货
 *     额度闸的预估敞口，与用户计价系数无关）。
 * 零金额运算实现——公式全部在 billing 域（单一真相）。
 */
import {
  Decimal,
  estimateMaxCost,
  type BillingEvent,
  type BillingQuote,
  type BillingQuoteCandidate,
} from '@tillgate/billing';
import type { SlidingWindowLimiter } from '@tillgate/runtime';
import type { BillingPort, BillingSignal, QuoteCandidate, UsageReceipt } from '@tillgate/inference';

export interface GatewayBillingConfig {
  reservationLimit: string;
  reservationPolicy: { mode: 'full' } | { mode: 'fixed'; amount: string };
  /** 结算积压准入（bridge 级调用：authorize 前置闸；requestId 恒服务端生成，
   *  HTTP 面无客户端重放路径，桥级 admission 不破坏 billing 内部的重放免疫） */
  assertCapacity?: () => Promise<void>;
  /**
   * TPM 预占收尾（成功结算主路径在网关进程内——本桥 signal 面即收尾点）：
   * request_succeeded → backfillTpm（释放预占 + 实值入 actual 维）；lease_renewed →
   * renewTpm（长流防 600s TTL 提前释放）；request_failed → releaseTpm。
   * limiter 件内部 best-effort（不反杀资金面）；崩溃残留预占由 TTL 兜底（worker
   * 恢复路径不回填——预占按分钟桶滚动，保守不放大窗口）。
   */
  limiter?: Pick<SlidingWindowLimiter, 'backfillTpm' | 'renewTpm' | 'releaseTpm'>;
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

/**
 * 免费判定走 Decimal 口径：Number() 会把空串/脏值
 * 归零误判免费并盖上 explicitlyFree；脏值不是免费——交由 billing 报价校验结构拒绝。
 */
const allPricesZero = (c: QuoteCandidate): boolean =>
  [
    c.inputPrice,
    c.cacheInputPrice,
    c.cacheWritePrice ?? '0',
    c.outputPrice,
    c.unitPrice ?? '0',
  ].every((p) => {
    try {
      return new Decimal(p).isZero();
    } catch {
      return false;
    }
  });

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

/** 报价组装：inputTokenUpperBound 逐候选盖章；显式免费 = 候选链全免费 */
function toQuote(input: {
  maxOutputTokens: number;
  inputTokenUpperBound: number;
  candidates: readonly QuoteCandidate[];
}): BillingQuote {
  return {
    maxOutputTokens: input.maxOutputTokens,
    candidates: input.candidates.map((c) => toQuoteCandidate(c, input.inputTokenUpperBound)),
    // billing 结构性校验兜底
    ...(input.candidates.every((c) => c.isFree === true || allPricesZero(c))
      ? { explicitlyFree: true }
      : {}),
  };
}

/** 蛇形事件词表 → billing 点分词表直译（收据结构两包同源，字段直传） */
function toBillingEvent(signal: BillingSignal): BillingEvent {
  switch (signal.type) {
    case 'upstream_started': {
      return {
        type: 'upstream.started',
        requestId: signal.requestId,
        leaseOwner: signal.leaseOwner,
        leaseMs: signal.leaseMs,
      };
    }
    case 'lease_renewed': {
      return {
        type: 'lease.renewed',
        requestId: signal.requestId,
        leaseOwner: signal.leaseOwner,
        leaseMs: signal.leaseMs,
      };
    }
    case 'request_succeeded': {
      return {
        type: 'request.succeeded',
        requestId: signal.requestId,
        receipt: signal.receipt as unknown as BillingEvent extends { receipt: infer R } ? R : never,
      };
    }
    case 'request_failed': {
      return { type: 'request.failed', requestId: signal.requestId, reason: signal.reason };
    }
  }
}

/** 渠道进货额度金额：官方价口径（coefficient=1，衡量上游成本，与用户费率卡无关） */
function officialPriceAmount(
  c: QuoteCandidate,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): string {
  return estimateMaxCost({
    estimatedInputTokens,
    maxOutputTokens,
    inputPrice: c.inputPrice,
    cacheInputPrice: c.cacheInputPrice,
    cacheWritePrice: c.cacheWritePrice ?? undefined,
    outputPrice: c.outputPrice,
    unitPrice: c.unitPrice ?? '0',
    unitUpperBound: c.unitUpperBound,
    coefficient: '1',
  }).toString();
}

/** TPM actual 维度（与 admitRequest/tryModelAdmission/tryChannelAdmission 的维度串同源） */
function tpmDimensionsOf(receipt: UsageReceipt): string[] {
  const dims: string[] = [];
  if (receipt.apiKeyId != null) dims.push(`key:${receipt.apiKeyId}`);
  dims.push(`user:${receipt.userId}`);
  dims.push(`model:${receipt.realModel}`);
  if (receipt.channelId != null) dims.push(`channel:${receipt.channelId}`);
  return dims;
}

/** TPM 实值口径 = 输入 + 缓存命中 + 输出（窗口按原始吞吐——缓存命中不占输入价但仍占窗口） */
function tpmTokensOf(receipt: UsageReceipt): number {
  const usage = receipt.usage as {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
  };
  return usage.inputTokens + (usage.cachedInputTokens ?? 0) + usage.outputTokens;
}

/** 结算信号后的 TPM 预占收尾（billing 先行；limiter 件内部 best-effort 不抛） */
async function finalizeTpmReservation(
  limiter: GatewayBillingConfig['limiter'],
  signal: BillingSignal,
): Promise<void> {
  if (limiter == null) return;
  if (signal.type === 'request_succeeded') {
    await limiter.backfillTpm(
      signal.requestId,
      tpmDimensionsOf(signal.receipt),
      tpmTokensOf(signal.receipt),
    );
  } else if (signal.type === 'lease_renewed') {
    await limiter.renewTpm(signal.requestId);
  } else if (signal.type === 'request_failed') {
    await limiter.releaseTpm(signal.requestId);
  }
}

export function createGatewayBilling(
  api: GatewayBillingApi,
  config: GatewayBillingConfig,
): BillingPort {
  return {
    async authorize(input) {
      if (config.assertCapacity != null) await config.assertCapacity();
      await api.authorize({
        requestId: input.requestId,
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        appId: input.appId,
        stream: input.stream,
        quote: toQuote(input),
        reservationLimit: config.reservationLimit,
        ...(config.reservationPolicy.mode === 'fixed'
          ? { reservationPolicy: { mode: 'fixed', amount: config.reservationPolicy.amount } }
          : {}),
        authorizationTtlMs: input.authorizationTtlMs,
      });
    },

    async signal(signal: BillingSignal) {
      await api.signal(toBillingEvent(signal));
      await finalizeTpmReservation(config.limiter, signal);
    },

    async reserveChannel(input) {
      const amount = officialPriceAmount(
        input.candidate,
        input.estimatedInputTokens,
        input.maxOutputTokens,
      );
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
