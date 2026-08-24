/**
 * 模型映射域规则（纯函数）：计价单位词表、变体计费配置形状、价格数值域、输入校验。
 * BillingConfig 形状与 @tillgate/db schema 的 $type 结构兼容（D2：双方结构契约，
 * domain 不 import db；装配点由类型系统校验一致性）。
 */
import type { ErrorContext } from '@tillgate/errors';
import { validateScheduleWindows, type PricingWindow } from '@tillgate/billing';
import { controlPlaneErrors } from '../../errors';
import { parseNonNegativeAmount } from '../money';
import { freePriceConsistent } from './model-pricing';

/** 计价单位词表（与 db CHECK model_mappings_pricing_unit_ck 同集合——新增单位须双改） */
export const PRICING_UNITS = ['token', 'request', 'image', 'second', 'char'] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

/** 变体价格配置（分辨率差价）：selector=请求参数名（如 size），prices=参数值→单价 */
export interface BillingConfig {
  strategy?: string;
  params?: {
    unitPrice?: string;
    selector?: string;
    prices?: Record<string, string>;
    /** schedule：分时段窗口（N 档；未命中时段回落基价列） */
    windows?: PricingWindow[];
  };
  reservation?: { strategy?: string; params?: Record<string, unknown> };
}

/** 上下文窗口上界（v1 同值：20 亿 token——超出即运营输入事故） */
const CONTEXT_LENGTH_MAX = 2_000_000_000;

export interface ModelPrices {
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice?: string;
  unitPrice?: string;
}

export interface ModelCreateInput {
  readonly externalName: string;
  readonly realModel: string;
  readonly contextLength?: number | null;
  readonly prices: ModelPrices;
  readonly pricingUnit?: string;
  readonly billingConfig?: BillingConfig | null;
  readonly isFree?: boolean;
  readonly billingPolicy?: Record<string, unknown> | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
}

export interface ModelPatchInput {
  readonly externalName?: string;
  readonly realModel?: string;
  readonly contextLength?: number | null;
  readonly status?: number;
  readonly prices?: Partial<ModelPrices>;
  readonly pricingUnit?: string;
  readonly billingConfig?: BillingConfig | null;
  readonly isFree?: boolean;
  readonly billingPolicy?: Record<string, unknown> | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
}

function invalid(detail: ErrorContext): never {
  throw controlPlaneErrors.business('invalid_model_input', detail);
}

/** 价格分量：非负十进制串且 ≤1e9（指数记法/负值/垃圾形状拒绝——数值域铁三角） */
function assertPrice(field: string, raw: string): void {
  if (parseNonNegativeAmount(raw) == null) invalid({ [field]: raw });
}

/** 变体计费配置形状：variant 必须带 selector 与非空 prices 表；schedule 必须带合法窗口表 */
// eslint-disable-next-line complexity -- 变体计费形状校验矩阵,分支平铺
function assertBillingConfig(config: BillingConfig | null | undefined): void {
  if (config == null) return;
  if (
    config.strategy !== 'flat' &&
    config.strategy !== 'variant' &&
    config.strategy !== 'schedule'
  ) {
    invalid({ billingConfig: { strategy: config.strategy ?? null } });
  }
  if (
    config.params?.selector !== undefined &&
    (config.params.selector.length === 0 || config.params.selector.length > 64)
  ) {
    invalid({ billingConfig: { selector: config.params.selector } });
  }
  if (config.params?.prices !== undefined) {
    for (const [key, price] of Object.entries(config.params.prices)) {
      if (key.length === 0 || key.length > 128) invalid({ billingConfig: { priceKey: key } });
      if (parseNonNegativeAmount(price) == null) invalid({ billingConfig: { prices: price } });
    }
  }
  if (config.strategy === 'variant') {
    const prices = config.params?.prices;
    if (prices == null || Object.keys(prices).length === 0) {
      invalid({ billingConfig: 'variant strategy requires a prices table' });
    }
    if (config.params?.selector == null) {
      invalid({ billingConfig: 'variant strategy requires a selector' });
    }
  }
  if (config.strategy === 'schedule') assertScheduleConfig(config);
}

/** schedule 窗口表校验：形状/重叠归 billing 纯函数（单一真相），价格数值域与 label 长度在此把关 */
function assertScheduleConfig(config: BillingConfig): void {
  const windows = config.params?.windows ?? [];
  const issue = validateScheduleWindows(windows);
  if (issue != null) invalid({ billingConfig: issue });
  for (const [index, window] of windows.entries()) {
    if (window.label !== undefined && (window.label.length === 0 || window.label.length > 32)) {
      invalid({ billingConfig: { window: index, label: window.label } });
    }
    const priceFields = {
      inputPrice: window.inputPrice,
      outputPrice: window.outputPrice,
      cacheInputPrice: window.cacheInputPrice,
      cacheWritePrice: window.cacheWritePrice,
      unitPrice: window.unitPrice,
    } as const;
    for (const [field, value] of Object.entries(priceFields)) {
      if (value !== undefined && parseNonNegativeAmount(value) == null) {
        invalid({ billingConfig: { window: index, [field]: value } });
      }
    }
  }
}

function assertContextLength(contextLength: number | null | undefined): void {
  if (
    contextLength !== undefined &&
    contextLength !== null &&
    (!Number.isInteger(contextLength) || contextLength < 1 || contextLength > CONTEXT_LENGTH_MAX)
  ) {
    invalid({ contextLength });
  }
}

function assertLimits(
  rpmLimit: number | null | undefined,
  tpmLimit: number | null | undefined,
): void {
  for (const [name, value] of [
    ['rpmLimit', rpmLimit],
    ['tpmLimit', tpmLimit],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isInteger(value) || value < 1 || value > 1e9)
    ) {
      invalid({ [name]: value });
    }
  }
}

/** isFree 全零价一致性（创建直判口径） */
function assertFreeConsistency(isFree: boolean, prices: ModelPrices): void {
  if (!freePriceConsistent(isFree, prices)) {
    throw controlPlaneErrors.business('free_price_conflict', {
      isFree,
      prices: {
        inputPrice: prices.inputPrice,
        outputPrice: prices.outputPrice,
        cacheInputPrice: prices.cacheInputPrice,
        cacheWritePrice: prices.cacheWritePrice ?? '0',
        unitPrice: prices.unitPrice ?? '0',
      },
    });
  }
}

/** 创建输入校验：名称域/价格数值域/单位词表/变体形状/上下文长度/限流域 + 免费一致性 */
// eslint-disable-next-line complexity, max-lines-per-function -- 创建校验矩阵:字段域+价格域+词表+免费一致性,平铺守卫
export function validateModelCreate(input: ModelCreateInput): {
  externalName: string;
  realModel: string;
  contextLength: number | null;
  prices: Required<ModelPrices>;
  pricingUnit: PricingUnit;
  billingConfig: BillingConfig;
  isFree: boolean;
  billingPolicy: Record<string, unknown> | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
} {
  if (input.externalName.length === 0 || input.externalName.length > 64) {
    invalid({ externalName: input.externalName });
  }
  if (input.realModel.length === 0 || input.realModel.length > 128) {
    invalid({ realModel: input.realModel });
  }
  assertContextLength(input.contextLength);
  const prices = {
    inputPrice: input.prices.inputPrice,
    outputPrice: input.prices.outputPrice,
    cacheInputPrice: input.prices.cacheInputPrice,
    cacheWritePrice: input.prices.cacheWritePrice ?? '0',
    unitPrice: input.prices.unitPrice ?? '0',
  };
  assertPrice('inputPrice', prices.inputPrice);
  assertPrice('outputPrice', prices.outputPrice);
  assertPrice('cacheInputPrice', prices.cacheInputPrice);
  assertPrice('cacheWritePrice', prices.cacheWritePrice);
  assertPrice('unitPrice', prices.unitPrice);
  const pricingUnit = input.pricingUnit ?? 'token';
  if (!(PRICING_UNITS as readonly string[]).includes(pricingUnit)) {
    invalid({ pricingUnit });
  }
  assertBillingConfig(input.billingConfig ?? null);
  assertLimits(input.rpmLimit, input.tpmLimit);
  const isFree = input.isFree ?? false;
  assertFreeConsistency(isFree, prices);
  return {
    externalName: input.externalName,
    realModel: input.realModel,
    contextLength: input.contextLength ?? null,
    prices,
    pricingUnit: pricingUnit as PricingUnit,
    billingConfig: input.billingConfig ?? {},
    isFree,
    billingPolicy: input.billingPolicy ?? null,
    rpmLimit: input.rpmLimit ?? null,
    tpmLimit: input.tpmLimit ?? null,
  };
}

/** 更新补丁校验（出现字段校验；价格/免费一致性由 application 按「旧值∪新值」合并判） */
// eslint-disable-next-line complexity -- 补丁校验矩阵(出现字段校验),平铺守卫
export function validateModelPatch(patch: ModelPatchInput): ModelPatchInput {
  if (
    patch.externalName !== undefined &&
    (patch.externalName.length === 0 || patch.externalName.length > 64)
  ) {
    invalid({ externalName: patch.externalName });
  }
  if (
    patch.realModel !== undefined &&
    (patch.realModel.length === 0 || patch.realModel.length > 128)
  ) {
    invalid({ realModel: patch.realModel });
  }
  assertContextLength(patch.contextLength);
  if (patch.status !== undefined && patch.status !== 0 && patch.status !== 1) {
    invalid({ status: patch.status });
  }
  const prices = patch.prices ?? {};
  for (const [field, value] of Object.entries(prices)) {
    if (value !== undefined) assertPrice(field, value);
  }
  if (
    patch.pricingUnit !== undefined &&
    !(PRICING_UNITS as readonly string[]).includes(patch.pricingUnit)
  ) {
    invalid({ pricingUnit: patch.pricingUnit });
  }
  assertBillingConfig(patch.billingConfig ?? null);
  assertLimits(patch.rpmLimit, patch.tpmLimit);
  return patch;
}
