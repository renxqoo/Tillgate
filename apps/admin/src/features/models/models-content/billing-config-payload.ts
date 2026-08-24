// 模型定价编辑器的构造与提交组装纯函数（仅模型表单消费）：计价卡片选项、差价档位/
// 分时段窗口行的构造与形状校验、提交载荷转换，以及 schedule/variant 互斥分流的
// billingConfig 组装。无 React 运行时依赖，行为由 __test__/model-form-pricing.test.ts 锁定。

import { CoinsIcon, FilmIcon, HashIcon, ImageIcon, TypeIcon } from 'lucide-react';
import type { useTranslations } from 'next-intl';

import { TIER_PRESETS, type PricingUnit } from './model-pricing';

/** 计价方式卡片（直接点选，不走下拉）：name=卡片标题，desc=卡片说明，文案走 models 目录 */
export function pricingUnitOptions(
  t: ReturnType<typeof useTranslations<'models'>>,
): ReadonlyArray<{ value: PricingUnit; name: string; desc: string; icon: typeof CoinsIcon }> {
  return [
    { value: 'token', name: t('unitTokenName'), desc: t('unitTokenDesc'), icon: CoinsIcon },
    { value: 'image', name: t('unitImageName'), desc: t('unitImageDesc'), icon: ImageIcon },
    { value: 'second', name: t('unitSecondName'), desc: t('unitSecondDesc'), icon: FilmIcon },
    { value: 'char', name: t('unitCharName'), desc: t('unitCharDesc'), icon: TypeIcon },
    { value: 'request', name: t('unitRequestName'), desc: t('unitRequestDesc'), icon: HashIcon },
  ];
}

/** 取价参数名候选（按计价方式给出常用请求体字段，直接选择而非手输；支持 "size:quality" 组合键） */
export const SELECTOR_OPTIONS: Partial<Record<PricingUnit, ReadonlyArray<string>>> = {
  image: ['size', 'quality', 'size:quality', 'model'],
  second: ['resolution', 'quality', 'model'],
  char: ['model', 'voice'],
  request: ['model'],
};

/** 各计价方式默认取价参数名（切换计价方式时重置；编辑回显优先用存量值） */
export const DEFAULT_SELECTOR: Partial<Record<PricingUnit, string>> = {
  image: 'size',
  second: 'resolution',
  char: 'model',
  request: 'model',
};

/** 差价档位行（variant 策略编辑态）：label=预设档位名，value=固定参数值，custom=自定义行 */
export interface TierRow {
  /** 档位名（预设档位显示用；自定义档位 = 参数值本身） */
  label: string;
  /** 计费匹配用的请求参数值 */
  value: string;
  price: string;
  /** 预设档位是否启用（勾选）；自定义档位恒开 */
  on: boolean;
  custom: boolean;
}

/** 由计价单位 + 既有 billingConfig 构造档位行：参数值（或档位名）精确匹配预设归位，其余进自定义行 */
export function buildTiers(
  unit: string,
  cfg?: { params?: { selector?: string; prices?: Record<string, string> } },
): TierRow[] {
  const presets = TIER_PRESETS[unit as PricingUnit] ?? [];
  const prices = cfg?.params?.prices ?? {};
  const rows: TierRow[] = presets.map((p) => {
    const price = prices[p.value] ?? prices[p.label];
    return { label: p.label, value: p.value, price: price ?? '', on: price != null, custom: false };
  });
  const known = new Set([...presets.map((p) => p.value), ...presets.map((p) => p.label)]);
  for (const [key, price] of Object.entries(prices)) {
    if (!known.has(key)) rows.push({ label: key, value: key, price, on: true, custom: true });
  }
  return rows;
}

/** 分时段窗口行（schedule 策略编辑态）：start/end = HH:MM，价格字段空串 = 不覆盖该轴 */
export interface WindowRow {
  label: string;
  start: string;
  end: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  unitPrice: string;
}

export const EMPTY_WINDOW_ROW: WindowRow = {
  label: '',
  start: '18:00',
  end: '07:00',
  inputPrice: '',
  outputPrice: '',
  cacheInputPrice: '',
  unitPrice: '',
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** billingConfig 回显 → 窗口行（schedule 之外 / 空表 → 空数组） */
export function buildWindows(cfg?: {
  strategy?: string;
  params?: { windows?: Array<Record<string, string>> };
}): WindowRow[] {
  if (cfg?.strategy !== 'schedule') return [];
  return (cfg.params?.windows ?? []).map((w) => ({
    label: w.label ?? '',
    start: w.start ?? '',
    end: w.end ?? '',
    inputPrice: w.inputPrice ?? '',
    outputPrice: w.outputPrice ?? '',
    cacheInputPrice: w.cacheInputPrice ?? '',
    unitPrice: w.unitPrice ?? '',
  }));
}

/** 窗口行有效性（形状面）：HH:MM、start ≠ end、至少一个价格字段——重叠/数值域由服务端把关 */
export function windowRowInvalid(row: WindowRow): boolean {
  const prices = [row.inputPrice, row.outputPrice, row.cacheInputPrice, row.unitPrice];
  const hasPrice = prices.some((p) => p.trim() !== '');
  return !HHMM_RE.test(row.start) || !HHMM_RE.test(row.end) || row.start === row.end || !hasPrice;
}

/** 窗口行 → 提交形状：空串字段剔除（字段级覆盖——未覆盖轴回落基价列） */
export const trimToPayload = (v: string) => (v.trim() === '' ? undefined : v.trim());

export function toWindowPayload(row: WindowRow) {
  const pick = (v: string) => trimToPayload(v);
  return {
    ...(pick(row.label) !== undefined ? { label: pick(row.label) } : {}),
    start: row.start,
    end: row.end,
    ...(pick(row.inputPrice) !== undefined ? { inputPrice: pick(row.inputPrice) } : {}),
    ...(pick(row.outputPrice) !== undefined ? { outputPrice: pick(row.outputPrice) } : {}),
    ...(pick(row.cacheInputPrice) !== undefined
      ? { cacheInputPrice: pick(row.cacheInputPrice) }
      : {}),
    ...(pick(row.unitPrice) !== undefined ? { unitPrice: pick(row.unitPrice) } : {}),
  };
}

/** billingConfig 提交载荷形状（strategy 单值：schedule=分时段 / variant=参数差价） */
export interface BillingConfigPayload {
  strategy?: string;
  params?: {
    selector?: string;
    prices?: Record<string, string>;
    windows?: Array<{
      label?: string;
      start: string;
      end: string;
      inputPrice?: string;
      outputPrice?: string;
      cacheInputPrice?: string;
      cacheWritePrice?: string;
      unitPrice?: string;
    }>;
  };
}

/** ModelForm 差价编辑器并入的提交载荷扩展（billingConfig 不走 RHF 字段） */
export type WithBillingConfig<V> = V & { billingConfig?: BillingConfigPayload };

/**
 * billingConfig 提交组装（与 ModelForm 原 handleSubmit 内联逻辑逐字对应）：
 * 分时段（schedule）优先于参数差价（strategy 单值互斥）——启用即按窗口表提交，
 * 空窗/坏窗回 error 'windows'；差价分支中单位计价下勾选未填齐回 error 'tiers'。
 * 错误分流只回标记，setError 文案由调用方（编排器）落地。
 */
export function buildBillingConfigPayload(input: {
  scheduleOn: boolean;
  windows: WindowRow[];
  tiers: TierRow[];
  selector: string;
  pricingUnit: string;
  unitMode: boolean;
}): {
  billingConfig?: BillingConfigPayload;
  error?: 'windows' | 'tiers';
} {
  const { scheduleOn, windows, tiers, selector, pricingUnit, unitMode } = input;
  // 分时段（schedule）优先于参数差价（strategy 单值互斥）：启用即按窗口表提交
  if (scheduleOn) {
    if (windows.length === 0 || windows.some((w) => windowRowInvalid(w))) {
      return { error: 'windows' };
    }
    return {
      billingConfig: {
        strategy: 'schedule',
        params: { windows: windows.map(toWindowPayload) },
      },
    };
  }
  // 差价档位 → variant billingConfig：勾选且填写完整的档位进价格表（预扣取最高价由计费域保证）
  const enabled = tiers.filter((tr) => tr.on);
  const active = enabled.filter((tr) => tr.value.trim() !== '' && tr.price.trim() !== '');
  if (unitMode && active.length !== enabled.length) {
    return { error: 'tiers' };
  }
  if (!unitMode || active.length === 0) return {};
  return {
    billingConfig: {
      strategy: 'variant',
      params: {
        selector: selector.trim() || DEFAULT_SELECTOR[pricingUnit as PricingUnit] || 'model',
        prices: Object.fromEntries(active.map((tr) => [tr.value.trim(), tr.price.trim()])),
      },
    },
  };
}
