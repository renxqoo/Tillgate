/**
 * 目录汇率域规则（纯函数）：生效口径换算、域校验、尾零规范化。
 *
 * 生效语义（对账口径）：
 *   基准汇率 base     = override（最近 manual 行）?? 最近 auto 行
 *   预填换算 effective = base ×(1 + bufferPct/100)   ← 点差不叠在覆盖值上（手动值自带运营判断）
 *   usage_logs.fx_rate 落的是 base（市场真相）；点差只进导入 provenance
 */
import Decimal from 'decimal.js';
import { controlPlaneErrors } from '../../errors';

/** 汇率域与点差域（语义常量——非部署配置） */
export const RATE_MIN = 0.01;
export const RATE_MAX = 1000;
export const BUFFER_PCT_MAX = 50;

/** catalog_fx 缓存视图形状（system_configs['catalog_fx']；真相在 fx_rates 追加表与审计） */
export interface FxConfig {
  mode: 'auto' | 'override';
  bufferPct: string;
  overrideRate: string | null;
  currentRate: string | null;
  currentFxRateId: number | null;
  source: string | null;
  fetchedAt: string | null;
}

export const EMPTY_FX_CONFIG: FxConfig = {
  mode: 'auto',
  bufferPct: '0',
  overrideRate: null,
  currentRate: null,
  currentFxRateId: null,
  source: null,
  fetchedAt: null,
};

/** 对外汇率状态（comparison 载荷与运维面共用） */
export interface FxState {
  mode: 'auto' | 'override';
  /** 基准（1 USD = ? CNY；请求收据快照的是它） */
  baseRate: string | null;
  /** 预填换算用生效汇率 = base ×(1+buffer/100)；base 缺失时 null（UI 只展示目录原价） */
  effectiveRate: string | null;
  bufferPct: string;
  source: string | null;
  fxRateId: number | null;
  fetchedAt: string | null;
}

/** 汇率域校验（0.01–1000）；合法返回规范化字符串（Number 经 String 归一） */
export function normalizeRate(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < RATE_MIN || n > RATE_MAX) {
    throw controlPlaneErrors.business('invalid_fx_rate', { rate: raw });
  }
  return String(n);
}

/** 点差域校验（0–50%） */
export function normalizeBuffer(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > BUFFER_PCT_MAX) {
    throw controlPlaneErrors.business('invalid_fx_buffer', { bufferPct: raw });
  }
  return String(n);
}

/** 生效汇率 = base ×(1+buffer/100)（Decimal；预填展示用——不叠在覆盖值上由调用方判 mode） */
export function applyBuffer(base: string, bufferPct: string): string {
  return new Decimal(base).times(new Decimal(1).plus(new Decimal(bufferPct).div(100))).toString();
}

/** numeric 列尾零规范化（'0.500' → '0.5'；'2.000' → '2'——快照形态稳定，指纹友好） */
export function trimNumeric(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}
