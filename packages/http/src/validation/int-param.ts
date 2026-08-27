/**
 * 路径参数解析：必须为正整数，否则 400 http.invalid_path_param。
 * 防止 NaN / 负数透传到 DB 层，把本应 4xx 的客户端错误变成 500。
 */
import type { Context } from 'hono';
import { HttpErrors } from '../errors/catalog';

export function intParam(c: Context, name: string): number {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value) || value < 1) {
    throw HttpErrors.business('invalid_path_param', { name });
  }
  return value;
}
