import { z } from "zod";

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
  const { message = "请输入有效数字" } = options;
  return z
    .string()
    .refine((v) => v.trim() !== "", "必填")
    .refine((v) => Number.isFinite(Number(v)), message)
    .transform((v) => Number(v));
}
