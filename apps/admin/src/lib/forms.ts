import * as z from 'zod';

/**
 * 数字文本字段 schema（配合 NumberField 组件使用）。
 *
 * 根因修复：编辑期间输入以字符串保存（空串合法），提交时才解析为数字。
 * 旧写法 z.coerce.number() / Number(e.target.value) 会把空串静默转成 0，
 * 导致输入框清不掉 0、也无法正常覆盖输入。
 *
 * 空串 → 「必填」错误；非数字 → 自定义错误。
 */
export function numericText(options: { message?: string } = {}) {
  const { message = 'Enter a valid number' } = options;
  return z
    .string()
    .refine((v) => v.trim() !== '', 'Required')
    .refine((v) => Number.isFinite(Number(v)), message)
    .transform((v) => Number(v));
}

/**
 * 精确十进制金额字段。返回原始字符串，避免金额在提交前经过 IEEE-754 number。
 * 最终上限与小数位约束仍由 API 的资金 schema 负责。
 */
export function moneyText(
  options: {
    message?: string;
    allowNegative?: boolean;
    allowZero?: boolean;
    /** 允许空串（可空字段：空 = 不提交，由调用方决定语义——如缓存写价留空回落输入价） */
    allowEmpty?: boolean;
  } = {},
) {
  const {
    message = 'Enter a valid amount',
    allowNegative = false,
    allowZero = true,
    allowEmpty = false,
  } = options;
  const pattern = allowNegative ? /^-?\d{1,20}(?:\.\d{1,18})?$/ : /^\d{1,20}(?:\.\d{1,18})?$/;
  return z
    .string()
    .refine((v) => (allowEmpty ? v === '' || pattern.test(v) : pattern.test(v)), message)
    .refine((v) => allowZero || !/^-?0+(?:\.0+)?$/.test(v), 'Amount must be non-zero');
}
