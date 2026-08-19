/**
 * 定价策略注册表（层 2）——「这个模型的单价怎么选/算」的单一真相。
 *
 * 与计量维度（pricingUnit / measurement.ts）正交：
 *   pricingUnit 回答「按什么计数」；策略回答「每个单位多少钱」。
 *
 * 策略只产出 resolvedUnitPrice（解析后的单价）——公式 calcAmount 不变。
 * 新公式（阶梯/混合/动态）= 加一个策略对象，零侵入公式/管线/结算。
 */
import { Decimal } from '../wallet/money.js';
import type { ReservationPolicyConfig } from './reservation-strategy.js';

/** 模型映射的计费配置（DB JSONB 形状） */
export interface BillingConfig {
  strategy?: string;
  params?: {
    /** flat：单价（缺省取 model_mappings.unitPrice 列） */
    unitPrice?: string;
    /** variant：请求体哪个参数选价（支持 "size:quality" 组合键） */
    selector?: string;
    /** variant：变体 → 单价表 */
    prices?: Record<string, string>;
    /** tiered（将来）：阶梯 */
    tiers?: Array<{ upTo: string | null; price: string }>;
  };
  /** 预扣策略（层 3，与定价策略正交）：strategy + params 通用形状，见 reservation-strategy.ts */
  reservation?: ReservationPolicyConfig;
}

export interface PricingContext {
  /** 计量上界（预扣口径） */
  units: number;
  /** 请求体（变体选择器从中取参数值） */
  body: Record<string, unknown>;
  /** 模型映射的计费配置 */
  config: BillingConfig;
  /** 映射列的缺省单价（billingConfig 未命中时的回落） */
  fallbackUnitPrice: string;
}

export interface PricingStrategy {
  /** 解析预扣单价（保守——变体未命中取表中最高价） */
  estimateUnitPrice(context: PricingContext): string;
  /** 解析结算单价（精确——请求参数已定，从表选或回落） */
  settleUnitPrice(context: PricingContext): string;
}

/** 从请求体构造变体键：selector "size:quality" → body.size + ':' + body.quality */
function variantKey(selector: string, body: Record<string, unknown>): string {
  return selector
    .split(':')
    .map((field) => String(body[field] ?? ''))
    .join(':');
}

/** 表中最高价（保守上界——请求参数缺省/未命中时用） */
function highestPrice(prices: Record<string, string>): string {
  let max = new Decimal(0);
  for (const price of Object.values(prices)) {
    const d = new Decimal(price);
    if (d.gt(max)) max = d;
  }
  return max.toString();
}

// ---- flat：unitPrice 列或 config.params.unitPrice 直接生效 ----
const flatStrategy: PricingStrategy = {
  estimateUnitPrice: (ctx) => ctx.config.params?.unitPrice ?? ctx.fallbackUnitPrice,
  settleUnitPrice: (ctx) => ctx.config.params?.unitPrice ?? ctx.fallbackUnitPrice,
};

// ---- variant：按请求参数从价格表选，未命中取最高价（estimate）/回落（settle）----
const variantStrategy: PricingStrategy = {
  estimateUnitPrice: (ctx) => {
    const prices = ctx.config.params?.prices;
    if (prices == null) return ctx.fallbackUnitPrice;
    const selector = ctx.config.params?.selector;
    if (selector != null) {
      const key = variantKey(selector, ctx.body);
      if (prices[key] != null) return prices[key]!;
    }
    return highestPrice(prices); // 保守：参数未指定 → 取最高价
  },
  settleUnitPrice: (ctx) => {
    const prices = ctx.config.params?.prices;
    if (prices == null) return ctx.fallbackUnitPrice;
    const selector = ctx.config.params?.selector;
    if (selector != null) {
      const key = variantKey(selector, ctx.body);
      if (prices[key] != null) return prices[key]!;
    }
    return ctx.config.params?.unitPrice ?? ctx.fallbackUnitPrice; // 回落缺省
  },
};

// ---- 注册表：新公式 = 加一行 ----
export const PRICING_STRATEGIES: Record<string, PricingStrategy> = {
  flat: flatStrategy,
  variant: variantStrategy,
  // tiered: tieredStrategy,     ← 将来
  // hybrid: hybridStrategy,     ← 将来
};

/** 按配置选策略；未声明 = flat（现有模型零迁移兼容） */
export function strategyOf(config: BillingConfig): PricingStrategy {
  return PRICING_STRATEGIES[config.strategy ?? 'flat'] ?? flatStrategy;
}
