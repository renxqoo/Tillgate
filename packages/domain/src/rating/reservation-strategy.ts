/**
 * 预扣策略注册表（层 3）——「这个模型押多少、何时放行」的单一真相。
 *
 * 与定价策略（pricing-strategy.ts）正交、同构：
 *   定价策略回答「每个单位多少钱」；预扣策略回答「预扣如何保底、余额不足何时放行」。
 * 两轴都声明在 model_mappings.billing_config（DB JSONB，数据驱动）：
 *   { "strategy": "variant", "params": {…}, "reservation": { "strategy": "floor", "params": {…} } }
 *
 * 策略只产出两条规则，消费点各一处：
 *   unitFloorOf    预扣单位保底 → build-quote（作用于计量上界，只抬不降：
 *                  视频「至少 5 秒的钱」、图片「至少 1 张的钱」）
 *   balanceFloorOf 余额放行下限 → authorize/planFunding（可用额 ≥ 此值即放行、
 *                  hold 封顶实筹额——文本模型「余额 0.1 就能跑」；透支缺口由
 *                  结算 §4 补充授权兜底，绝不免费放行）
 *
 * 未声明 reservation = full（现行语义）：全额保守预扣、不足即拒（fail-closed）。
 * 新预扣逻辑（按比例/分档/时段……）= 加一个策略对象，零侵入管线与结算。
 */
import { Decimal } from '../wallet/money.js';
import { BillingConfigurationError } from './errors.js';

/** 预扣策略配置（billing_config.reservation 的形状；params 由策略自定义——通用） */
export interface ReservationPolicyConfig {
  strategy?: string;
  params?: Record<string, unknown>;
}

export interface ReservationStrategy {
  /** 预扣单位保底（与 pricingUnit 同维的正整数；null = 不干预） */
  unitFloorOf(config: ReservationPolicyConfig): number | null;
  /** 余额放行下限（元，正数；null = 须全额覆盖保守预估） */
  balanceFloorOf(config: ReservationPolicyConfig): string | null;
}

/** 正整数参数读取（保底单位维度）；声明了但非法 = 配置事故，结构拒绝 */
function positiveIntParam(params: Record<string, unknown>): number | null {
  const value = params.units;
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BillingConfigurationError('invalid_reservation_units');
  }
  return value;
}

/** 正金额参数读取（放行余额维度）；同上 fail-closed */
function positiveAmountParam(params: Record<string, unknown>): string | null {
  const value = params.balance;
  if (value === undefined) return null;
  let d: Decimal;
  try {
    d = new Decimal(String(value));
  } catch {
    throw new BillingConfigurationError('invalid_reservation_balance');
  }
  if (!d.isFinite() || d.lte(0)) {
    throw new BillingConfigurationError('invalid_reservation_balance');
  }
  return d.toString();
}

// ---- full：不干预（缺省 = 现行全额保守预扣语义） ----
const fullStrategy: ReservationStrategy = {
  unitFloorOf: () => null,
  balanceFloorOf: () => null,
};

// ---- floor：通用保底策略——params { units?: 正整数, balance?: 正金额 } ----
const floorStrategy: ReservationStrategy = {
  unitFloorOf: (config) => positiveIntParam(config.params ?? {}),
  balanceFloorOf: (config) => positiveAmountParam(config.params ?? {}),
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
  if (strategy == null) throw new BillingConfigurationError('unknown_reservation_strategy');
  return strategy;
}

/** 候选链放行阈值：多候选（主 + fallback）取最严（最大 balanceFloor）——fail-closed */
export function strictestBalanceFloor(
  candidates: readonly { reservation?: ReservationPolicyConfig }[],
): string | null {
  let strictest: Decimal | null = null;
  for (const candidate of candidates) {
    const config = candidate.reservation;
    if (config == null) continue;
    const floor = reservationStrategyOf(config).balanceFloorOf(config);
    if (floor == null) continue;
    const d = new Decimal(floor);
    if (strictest == null || d.gt(strictest)) strictest = d;
  }
  return strictest?.toString() ?? null;
}

/**
 * 放行判定（planFunding 消费）：planned = 瀑布实筹份额，required = 保守预估。
 *   floor == null（缺省）→ 必须足额（planned ≥ required）；
 *   floor 配置 → planned ≥ floor 即放行（hold = planned，敞口结算兜底）。
 */
export function admitsReservation(
  floor: string | null,
  planned: Decimal,
  required: Decimal,
): boolean {
  if (floor == null) return planned.gte(required);
  return planned.gte(new Decimal(floor));
}
