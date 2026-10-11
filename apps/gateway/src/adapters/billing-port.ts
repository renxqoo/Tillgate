/**
 * inference BillingPort 的生产实现（装配面专属）：
 * 包一层 @tillgate/billing facade 的 authorize/signal/reserveChannel 三用例——
 *   authorize：inference 候选链 → BillingQuote（inputTokenUpperBound 逐候选盖章、
 *     explicitlyFree = 候选链全免费）；reservationLimit/Policy 由 gateway config 持有；
 *   signal：蛇形词表 → billing 点分词表 + 收据字段结构对齐；
 *   reserveChannel：官方价口径（coefficient=1）estimateMaxCost 自算 amount（进货
 *     额度闸的预估敞口，与用户计价系数无关）。校准命中且渠道匹配时用分段公式
 *     收缩（docs §4.1），同时产出 conservativeChannelAmount（B4 二级上界）。
 * 零金额运算实现——公式全部在 billing 域（单一真相）。
 */
import {
  Decimal,
  estimateMaxCost,
  type BillingEvent,
  type BillingQuote,
  type BillingQuoteCandidate,
  type FundingReservationPolicy,
} from '@tillgate/billing';
import type { SlidingWindowLimiter } from '@tillgate/runtime';
import { calibratedChannelAmount } from '@tillgate/inference';
import type { BillingPort, BillingSignal, QuoteCandidate, UsageReceipt } from '@tillgate/inference';
import type { ChannelCandidate } from '@tillgate/inference';

/** 渠道成本五轴形状（ChannelCandidate.costPrices——避免重复内联） */
interface QuoteCandidateCostPrices extends NonNullable<ChannelCandidate['costPrices']> {}

export interface GatewayBillingConfig {
  /** 单笔预估敞口上限解析（每次 authorize 现读——TTL 缓存的 system_configs KV） */
  resolveReservationLimit: () => Promise<string>;
  /** 预扣策略解析（每次 authorize 现读——TTL 缓存的 system_configs KV，admin 动态调整） */
  resolveReservationPolicy: () => Promise<FundingReservationPolicy>;
  /** 校准上下文解析（可选——user_side 门控 billing quote 候选透传，§9 步骤 3） */
  resolveCalibration?: () => Promise<{ config: { userSide: boolean } } | null>;
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
    /** B4 二级上界（docs §3.2c）：非空=校准预留落列；null=保守预留清列（换渠防残留） */
    conservativeChannelAmount: string | null;
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

/**
 * inference 候选 → billing 报价候选（字段同源；inputUpperBound 逐候选盖章）。
 * user_side 门（P2/§2.3 表）：false 时校准界不透传——billing 用户冻结额走
 * 字节界（§9 步骤 2 渠道侧试点的独立开关）；渠道金额面不经此函数。
 */
function toQuoteCandidate(
  c: QuoteCandidate,
  inputTokenUpperBound: number,
  userSide: boolean,
): BillingQuoteCandidate {
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
    // 校准界透传（user_side=true 才进 billing quote——冻结额收缩开关；B2 不消费 I0）
    ...(userSide && c.calibratedInputTokenUpperBound != null
      ? { calibratedInputTokenUpperBound: c.calibratedInputTokenUpperBound }
      : {}),
    pricingUnit: c.pricingUnit,
    unitUpperBound: c.unitUpperBound,
    billingPolicyFingerprint: c.billingPolicyFingerprint,
    ...(c.pricingWindow != null ? { pricingWindow: c.pricingWindow } : {}),
  };
}

/** 报价组装：inputTokenUpperBound 逐候选盖章；免费 = 候选链价格全零（价格推导，无平行标记） */
function toQuote(input: {
  maxOutputTokens: number;
  inputTokenUpperBound: number;
  candidates: readonly QuoteCandidate[];
  calibration?: Parameters<BillingPort['authorize']>[0]['calibration'];
  userSide: boolean;
}): BillingQuote {
  return {
    maxOutputTokens: input.maxOutputTokens,
    candidates: input.candidates.map((c) =>
      toQuoteCandidate(c, input.inputTokenUpperBound, input.userSide),
    ),
    ...(input.candidates.every(allPricesZero) ? { explicitlyFree: true } : {}),
    ...(input.calibration != null ? { calibration: input.calibration } : {}),
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

/**
 * 渠道进货额度金额：成本口径（coefficient=1，衡量上游成本，与用户费率卡无关）。
 * 渠道绑定成本五轴（含 cost_config 窗口解析——与结算同一快照）；
 * **undefined = 成本面缺失（绑定全 NULL 未标 free）→ 金额 0（闸门不预扣不拒绝）**，
 * 与结算口径同源（结算对未配置成本按 0 扣减）——静默回落用户卖价会把免费/低价
 * 渠道按卖价虚拒（2026-08-30/31 生产事故：敞口 $2.13 > 双渠道余额 → 全 503）。
 */
function channelCostAmount(input: {
  candidate: QuoteCandidate;
  costPrices?: QuoteCandidateCostPrices;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}): string {
  const { candidate: c, costPrices: cost } = input;
  if (cost == null) return '0';
  return estimateMaxCost({
    estimatedInputTokens: input.estimatedInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    inputPrice: cost.inputPrice,
    cacheInputPrice: cost.cacheInputPrice,
    cacheWritePrice: cost.cacheWritePrice,
    outputPrice: cost.outputPrice,
    unitPrice: cost.unitPrice,
    unitUpperBound: c.unitUpperBound,
    coefficient: '1',
  }).toString();
}

/**
 * 渠道敞口双金额（docs §4.1）：
 *   amount = 校准命中且渠道匹配（reserve 时 channel == calibration.channelId）
 *           且候选带校准界时按分段公式；否则保守口径（与现状一致）。
 *   conservativeChannelAmount = 保守口径金额（B4 二级上界——reserve 时点
 *           同价格快照字节界算出，价格漂移探测器基准）。
 * 渠道不匹配（failover 到冷渠道）不进打折：tokenizer/缓存双保险（v3-R1/R2）。
 */
function channelExposureAmounts(input: {
  candidate: QuoteCandidate;
  costPrices?: QuoteCandidateCostPrices;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  channelId: number;
  calibration?: Parameters<BillingPort['reserveChannel']>[0]['calibration'];
}): { amount: string; conservativeChannelAmount: string | null } {
  const { costPrices: cost } = input;
  if (cost == null) return { amount: '0', conservativeChannelAmount: null };
  const conservative = channelCostAmount(input);
  const calibrated = calibratedExposureOf(input, cost);
  if (calibrated != null) {
    return { amount: calibrated, conservativeChannelAmount: conservative };
  }
  return { amount: conservative, conservativeChannelAmount: null };
}

/** 分段公式消费（渠道匹配 + 候选校准界齐备才启用；否则 null = 保守） */
function calibratedExposureOf(
  input: Parameters<typeof channelExposureAmounts>[0],
  cost: NonNullable<QuoteCandidateCostPrices>,
): string | null {
  const { calibration } = input;
  if (calibration == null) return null;
  if (
    calibration.channelId == null ||
    calibration.inputTokens == null ||
    calibration.cacheRatio == null
  ) {
    return null; // 前缀事实-only 快照（未命中）→ 保守
  }
  if (input.channelId !== calibration.channelId) return null; // 渠道不匹配 → 保守
  const bound = input.candidate.calibratedInputTokenUpperBound;
  if (bound == null) return null; // 候选未盖章（未命中/非主候选/user_side 关）→ 保守
  // P9：无缓存定价（读价 ≤ 0 且无写价）不分段——cacheSeg 会按 0 价塌陷
  // （≈免费），该渠道每笔进 over_exposure 容错区间；回保守口径。
  const readPrice = new Decimal(cost.cacheInputPrice);
  const writePrice = cost.cacheWritePrice != null ? new Decimal(cost.cacheWritePrice) : null;
  if (readPrice.lte(0) && (writePrice == null || writePrice.lte(0))) return null;
  const tailTokens = Math.max(bound - calibration.inputTokens, 0);
  const segmented = calibratedChannelAmount({
    seen: calibration.inputTokens,
    tailTokens,
    cacheRatio: calibration.cacheRatio,
    inputPrice: cost.inputPrice,
    cacheInputPrice: cost.cacheInputPrice,
    cacheWritePrice: cost.cacheWritePrice,
    outputPrice: cost.outputPrice,
    maxOutputTokens: input.maxOutputTokens,
  });
  return segmented?.amount ?? null;
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

/** authorize 体检出：动态风控值（策略/上限/校准 user_side）现读 + 形状收窄后透传 */
async function authorizeWithDynamicRisk(
  api: GatewayBillingApi,
  config: GatewayBillingConfig,
  input: Parameters<BillingPort['authorize']>[0],
): Promise<void> {
  if (config.assertCapacity != null) await config.assertCapacity();
  const [policy, reservationLimit, calibration] = await Promise.all([
    config.resolveReservationPolicy(),
    config.resolveReservationLimit(),
    config.resolveCalibration != null ? config.resolveCalibration() : Promise.resolve(null),
  ]);
  await api.authorize({
    requestId: input.requestId,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    appId: input.appId,
    stream: input.stream,
    quote: toQuote({ ...input, userSide: calibration?.config.userSide ?? false }),
    reservationLimit,
    ...(policy.mode === 'fixed'
      ? { reservationPolicy: { mode: 'fixed', amount: policy.amount } }
      : {}),
    authorizationTtlMs: input.authorizationTtlMs,
  });
}

export function createGatewayBilling(
  api: GatewayBillingApi,
  config: GatewayBillingConfig,
): BillingPort {
  return {
    async authorize(input) {
      await authorizeWithDynamicRisk(api, config, input);
    },

    async signal(signal: BillingSignal) {
      // TPM 收尾与 billing 结算解耦（finally）：billing 抛错（DB 抖动）时
      // release/renew 不丢——release/backfill 均幂等，settle 重试链重放安全
      try {
        await api.signal(toBillingEvent(signal));
      } finally {
        await finalizeTpmReservation(config.limiter, signal);
      }
    },

    async reserveChannel(input) {
      const { amount, conservativeChannelAmount } = channelExposureAmounts(input);
      const result = await api.reserveChannel({
        requestId: input.requestId,
        channelId: input.channelId,
        amount,
        // 显式携带（含 null = 非校准预留——换渠路径清列，P1：残留会让 B4 ②
        // 对价格漂移请求失明；undefined 仅测试桩用）
        conservativeChannelAmount,
      });
      // switched/remaining 透传（routing gates 消费进 trace——换渠转移的可观测事实）
      if (!result.allowed) return { allowed: false } as const;
      return {
        allowed: true,
        ...(result.switched === true ? { switched: true } : {}),
        ...(result.remaining != null ? { remaining: result.remaining } : {}),
      };
    },
  };
}

export type { UsageReceipt };
