/**
 * 契约共享件：用户面分页（page/limit strict——非法值 400，limit ≤100 默认 20；
 * 与 @tokenlens/http 的 page_size 容错词表语义不同，用户面钉死 v1 口径）、
 * 金额输入结构性校验（资金输入只收十进制字符串，避免 JSON number 精度损失）、
 * 路径参数校验（body/query 走 http 包 jsonBody/query 中间件——失败统一
 * http.validation_failed；路径参数无中间件位，此处 safeParse → invalid_path_param）。
 */
import { z } from 'zod';
import { HttpErrors } from '@tokenlens/http';
import { Decimal, isValidAmountString, parsePositiveAmount } from '@tokenlens/billing';

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Key/成员限额类金额：十进制字符串形态 + 正数且 < 1e12（v1 key-limits 口径） */
export function isValidSpendLimitInput(raw: string): boolean {
  if (!isValidAmountString(raw)) return false;
  try {
    return parsePositiveAmount(raw).lessThan(new Decimal('1000000000000'));
  } catch {
    return false;
  }
}

/** 路径参数校验：失败 400 http.invalid_path_param（与 body/query 校验同语义位） */
export function parsePath<T extends z.ZodType>(schema: T, input: Record<string, string | undefined>): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const context: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join('.');
      if (context[key] === undefined) context[key] = issue.message;
    }
    throw HttpErrors.business('invalid_path_param', context);
  }
  return parsed.data;
}
