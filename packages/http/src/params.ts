import type { Context } from 'hono';
import { HttpError } from './errors.js';

/**
 * 路径参数解析：必须为正整数，否则 400。
 * 防止 NaN / 负数透传到 DB 层，把本应 4xx 的客户端错误变成 500。
 */
export function intParam(c: Context, name: string): number {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError('INVALID_PARAM', `路径参数 ${name} 必须为正整数`);
  }
  return value;
}
