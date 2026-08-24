/**
 * 预扣策略注册表（层 3）——「这个模型押多少、何时放行」的单一真相。
 *
 * 与定价策略（pricing-strategy.ts）正交、同构：
 *   定价策略回答「每个单位多少钱」；预扣策略回答「预扣如何保底、余额不足何时放行」。
 * 两轴都声明在 model_mappings.billing_config（DB JSONB，数据驱动）：
 *   { "strategy": "variant", "params": {…}, "reservation": { "strategy": "floor", "params": {…} } }
 *
 * 策略只产出一条规则，消费点一处：
 *   unitFloorOf    预扣单位保底 → build-quote（作用于计量上界，只抬不降：
 *                  视频「至少 5 秒的钱」、图片「至少 1 张的钱」）
 * 资金预留始终足额；策略只能抬高计量单位下限，不能降低资金准入线。
 *
 * 未声明 reservation = full（现行语义）：全额保守预扣、不足即拒（fail-closed）。
 * 新预扣逻辑（按比例/分档/时段……）= 加一个策略对象，零侵入管线与结算。
 */
import { BillingErrors } from '../errors.js';

/** 预扣策略配置（billing_config.reservation 的形状；params 由策略自定义——通用） */
export interface ReservationPolicyConfig {
  strategy?: string;
  params?: Record<string, unknown>;
}

export interface ReservationStrategy {
  /** 预扣单位保底（与 pricingUnit 同维的正整数；null = 不干预） */
  unitFloorOf(config: ReservationPolicyConfig): number | null;
}

/** 正整数参数读取（保底单位维度）；声明了但非法 = 配置事故，结构拒绝 */
function positiveIntParam(params: Record<string, unknown>): number | null {
  const value = params.units;
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw BillingErrors.business('invalid_reservation_units');
  }
  return value;
}

// ---- full：不干预（缺省 = 现行全额保守预扣语义） ----
const fullStrategy: ReservationStrategy = {
  unitFloorOf: () => null,
};

// ---- floor：通用保底策略——params { units?: 正整数 } ----
const floorStrategy: ReservationStrategy = {
  unitFloorOf: (config) => positiveIntParam(config.params ?? {}),
};

/** 注册表：新预扣逻辑 = 加一行 */
export const RESERVATION_STRATEGIES: Record<string, ReservationStrategy> = {
  full: fullStrategy,
  floor: floorStrategy,
};

/** 按配置选策略；未声明 = full（现有模型零迁移）；未知策略名 = 配置事故 */
export function reservationStrategyOf(config: ReservationPolicyConfig): ReservationStrategy {
  const name = config.strategy ?? 'full';
  const strategy = RESERVATION_STRATEGIES[name];
  if (strategy == null) {
    throw BillingErrors.business('unknown_reservation_strategy', { strategy: name });
  }
  return strategy;
}
