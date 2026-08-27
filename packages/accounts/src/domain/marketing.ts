/**
 * 拉新参数域(marketing_settings 单行表):金额非负、比例 ∈[0,1]、
 * 精度形状(整数 ≤10 位、小数 ≤18 位,DB numeric(38,18) 收口)。
 * 生效语义:下一动作生效、历史不重算(schema 注释即契约)。
 */

/** 金额与比例共用形状 `^\d{1,10}(\.\d{1,18})?$`(整数 ≤10 位、小数 ≤18 位) */
const MARKETING_AMOUNT_RE = /^\d{1,10}(\.\d{1,18})?$/;
const MARKETING_RATE_RE = /^\d{1,10}(\.\d{1,18})?$/;

import Decimal from 'decimal.js';

export interface MarketingSettingsPatch {
  /** 无条件注册赠送(元/人;0=关闭) */
  readonly signupGiftAmount?: string;
  /** 邀请注册双方奖励(元/人;0=关闭) */
  readonly referralSignupBonus?: string;
  /** 邀请人佣金比例(∈[0,1];0=关闭) */
  readonly referralCommissionRate?: string;
}

export interface MarketingSettings {
  readonly signupGiftAmount: string;
  readonly referralSignupBonus: string;
  readonly referralCommissionRate: string;
}

/** 校验补丁形状;不合法字段名列表返回(调用方翻译 marketing_settings_invalid) */
export function validateMarketingPatch(patch: MarketingSettingsPatch): string[] | null {
  const invalid: string[] = [];
  if (patch.signupGiftAmount !== undefined && !MARKETING_AMOUNT_RE.test(patch.signupGiftAmount)) {
    invalid.push('signupGiftAmount');
  }
  if (
    patch.referralSignupBonus !== undefined &&
    !MARKETING_AMOUNT_RE.test(patch.referralSignupBonus)
  ) {
    invalid.push('referralSignupBonus');
  }
  if (
    patch.referralCommissionRate !== undefined &&
    (!MARKETING_RATE_RE.test(patch.referralCommissionRate) ||
      new Decimal(patch.referralCommissionRate).greaterThan(1))
  ) {
    invalid.push('referralCommissionRate');
  }
  return invalid.length > 0 ? invalid : null;
}

/** C 端入口开关:两项激励任一 > 0 即显示 */
export function referralProgramEnabled(settings: MarketingSettings): boolean {
  return (
    new Decimal(settings.referralSignupBonus).greaterThan(0) ||
    new Decimal(settings.referralCommissionRate).greaterThan(0)
  );
}

/** 缺行兜底(全 0):行恒存在语义在适配器,域层提供等价缺省值 */
export const ZERO_MARKETING_SETTINGS: MarketingSettings = {
  signupGiftAmount: '0',
  referralSignupBonus: '0',
  referralCommissionRate: '0',
};
