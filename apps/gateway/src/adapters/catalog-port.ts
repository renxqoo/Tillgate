/**
 * inference CatalogPort 的生产实现（DESIGN C-G2，装配面专属）：
 * control-plane 只读目录（映射/渠道/费率卡三 store）+ billing 纯函数（系数解析/
 * 计量上界/预扣保底/变体单价——单一真相不复制）→ inference 快照。
 * 本件是调用序列编排，零规则实现（P5 红线：app 不形成第二套 domain/application）。
 *
 * 语义 = v1 build-quote.ts + resolve-channels.ts：
 *   coefficient = pickCoefficient(用户卡快照, {mappingId, pricingGroup})（无卡恒 '1'）；
 *   停用卡（status≠0）拒绝新请求（control_plane.rate_card_disabled → 403）；
 *   unitUpperBound = max(按请求体计量上界, 预扣保底)——只抬不降；
 *   unitPrice = 变体定价策略按请求体选择（hold == settle 单一价格快照）；
 *   时段价 = schedule 策略按准入时刻 + 计费时区解析整套覆盖（未覆盖轴回落列基价）；
 *   渠道候选基序 = priority/weight 降序（加权调度在 inference 域内）。
 */
import { createHash } from 'node:crypto';
import type { Db } from '@tokenlens/db';
import {
  postgresModelStore,
  postgresChannelStore,
  postgresRateCardStore,
} from '@tokenlens/control-plane/composition';
import type {
  ActiveMappingRow,
  RouteCandidateRow,
  UserRateCardContext,
} from '@tokenlens/control-plane';
import { controlPlaneErrors } from '@tokenlens/control-plane';
import {
  measurementOf,
  pickCoefficient,
  reservationStrategyOf,
  strategyOf,
  type RateCardCoefficientSnapshot,
} from '@tokenlens/billing';
import { createBillingTimezoneReader } from './billing-timezone.js';
import type {
  CatalogPricingContext,
  CatalogPort,
  ChannelCandidate,
  ModelMappingSnapshot,
  PricingUnit,
} from '@tokenlens/inference';

const PRICING_UNITS: ReadonlySet<string> = new Set(['token', 'request', 'image', 'second', 'char']);

function policyFingerprint(policy: Record<string, unknown> | null): string | null {
  return policy != null ? createHash('sha256').update(JSON.stringify(policy)).digest('hex') : null;
}

/** 用户卡上下文 → billing 系数快照（scope 行折叠为两张表） */
function toSnapshot(ctx: UserRateCardContext): RateCardCoefficientSnapshot {
  const snapshot: RateCardCoefficientSnapshot = {
    rateCardId: ctx.cardId,
    status: ctx.status,
    global: null,
    model: {},
    group: {},
  };
  for (const row of ctx.coefficients) {
    if (row.scope === 'global') snapshot.global = row.coefficient;
    else if (row.scope === 'model' && row.modelMappingId != null) {
      snapshot.model[row.modelMappingId] = row.coefficient;
    } else if (row.scope === 'group' && row.groupKey != null) {
      snapshot.group[row.groupKey] = row.coefficient;
    }
  }
  return snapshot;
}

/** 映射行 + 用户卡 + 请求体 + 准入时刻 → inference 快照（v1 buildQuote 候选装配的单映射形态） */
async function toSnapshotRow(
  row: ActiveMappingRow,
  card: UserRateCardContext | null,
  body: Readonly<Record<string, unknown>>,
  now: Date,
  readTimezone: () => Promise<string>,
): Promise<ModelMappingSnapshot> {
  if (card != null && card.status !== 0) {
    throw controlPlaneErrors.business('rate_card_disabled', { cardId: card.cardId });
  }
  const snapshot = card != null ? toSnapshot(card) : null;
  const billingConfig = row.billingConfig as Parameters<typeof strategyOf>[0];
  // 计量上界（层 1）：按映射声明的 pricingUnit 从请求体推（token 模型恒 0）
  const measured = measurementOf(
    row.pricingUnit as Parameters<typeof measurementOf>[0],
  ).unitsUpperBoundOf(body as Record<string, unknown>);
  // 预扣保底（层 3）：只抬不降（视频「至少 5 秒的钱」/图片「至少 1 张的钱」）
  const reservation = billingConfig.reservation ?? {};
  const unitFloor = reservationStrategyOf(reservation).unitFloorOf(reservation);
  const unitUpperBound = unitFloor != null ? Math.max(measured, unitFloor) : measured;
  const strategy = strategyOf(billingConfig);
  const pricingContext = {
    units: unitUpperBound,
    body: body as Record<string, unknown>,
    config: billingConfig,
    fallbackUnitPrice: row.unitPrice,
    now,
    timezone: await readTimezone(),
  };
  // 变体单价（层 2）：按 billingConfig 选公式；body 已知 → 变体即确定（hold == settle）
  const resolvedUnitPrice = strategy.settleUnitPrice(pricingContext);
  // 时段覆盖（层 2 schedule）：字段级——未覆盖轴回落列基价；命中标签进快照（收据审计列）
  const overrides = strategy.resolvePriceOverrides(pricingContext);
  const pricingUnit = PRICING_UNITS.has(row.pricingUnit)
    ? (row.pricingUnit as PricingUnit)
    : 'token';
  return {
    mappingId: row.id,
    externalModel: row.externalName,
    realModel: row.realModel,
    fallbackModels: row.fallbackModels ?? [],
    inputPrice: overrides?.inputPrice ?? row.inputPrice,
    cacheInputPrice: overrides?.cacheInputPrice ?? row.cacheInputPrice,
    cacheWritePrice:
      overrides?.cacheWritePrice ?? (row.cacheWritePrice === '0' ? null : row.cacheWritePrice),
    outputPrice: overrides?.outputPrice ?? row.outputPrice,
    unitPrice: overrides?.unitPrice ?? resolvedUnitPrice,
    pricingUnit,
    unitUpperBound,
    coefficient: pickCoefficient(snapshot, {
      modelMappingId: row.id,
      pricingGroup: row.pricingGroup,
    }),
    billingPolicyFingerprint: policyFingerprint(row.billingPolicy),
    ...(overrides?.pricingWindow != null ? { pricingWindow: overrides.pricingWindow } : {}),
  };
}

function toChannelCandidate(row: RouteCandidateRow): ChannelCandidate {
  return {
    channelId: row.channelId,
    channelName: row.channelName,
    providerName: row.providerName,
    protocol: row.providerProtocol,
    vendor: row.providerVendor,
    baseUrl: row.baseUrlOverride ?? row.providerBaseUrl,
    apiKeyEnc: row.apiKeyEnc,
    priority: row.priority,
    weight: row.weight,
    ...(row.rpmLimit != null ? { rpmLimit: row.rpmLimit } : {}),
    ...(row.tpmLimit != null ? { tpmLimit: row.tpmLimit } : {}),
    ...(row.upstreamBudget != null ? { upstreamBudget: row.upstreamBudget } : {}),
  };
}

/** 目录三 store 的消费面（db 已闭包绑定的读函数；postgres 工厂缺省，测试注入替身） */
export interface CatalogStores {
  models: {
    findActiveByExternalName(externalName: string): Promise<ActiveMappingRow | null>;
  };
  channels: { findRouteCandidates(realModel: string): Promise<RouteCandidateRow[]> };
  rateCards: { findActiveCardByUser(userId: number): Promise<UserRateCardContext | null> };
  /** 计费时区（TTL 缓存读 system_configs；schedule 策略墙钟口径） */
  billingTimezone: { read(): Promise<string> };
}

export function createGatewayCatalog(stores: CatalogStores): CatalogPort {
  return {
    async findMapping(
      externalModel,
      pricing: CatalogPricingContext,
    ): Promise<ModelMappingSnapshot | null> {
      const row = await stores.models.findActiveByExternalName(externalModel);
      if (row == null) return null;
      const card = await stores.rateCards.findActiveCardByUser(pricing.userId);
      return toSnapshotRow(row, card, pricing.body, pricing.now, stores.billingTimezone.read);
    },
    async resolveChannels(realModel): Promise<ChannelCandidate[]> {
      const rows = await stores.channels.findRouteCandidates(realModel);
      return rows.map(toChannelCandidate);
    },
  };
}

/** postgres 装配形态（assembly 消费；store 单例 + db 闭包绑定 + 时区缓存参数） */
export function createPostgresGatewayCatalog(
  db: Db,
  timezoneEnv: { ttlMs: number; fallback: string },
): CatalogPort {
  const readTimezone = createBillingTimezoneReader({ db, ...timezoneEnv });
  return createGatewayCatalog({
    models: {
      findActiveByExternalName: (name) => postgresModelStore.findActiveByExternalName(db, name),
    },
    channels: {
      findRouteCandidates: (realModel) => postgresChannelStore.findRouteCandidates(db, realModel),
    },
    rateCards: {
      findActiveCardByUser: (userId) => postgresRateCardStore.findActiveCardByUser(db, userId),
    },
    billingTimezone: { read: readTimezone },
  });
}
