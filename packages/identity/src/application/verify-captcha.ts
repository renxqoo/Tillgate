/** 人机验证:port 结果 → 错误目录翻译(invalid/unavailable 二分,边界映射归 app face) */
import { identityErrors } from '../domain/errors.js';
import type { IdentityUseCaseContext } from './context.js';

export async function verifyCaptcha(
  ctx: IdentityUseCaseContext,
  input: { token: string; remoteIp?: string },
): Promise<{ ok: true }> {
  if (ctx.captcha == null) {
    // 未装配 = 不可用(fail-closed;「未配置即跳过」的装配策略归 app 决定)
    throw identityErrors.business('captcha_unavailable', {});
  }
  const result = await ctx.captcha.verify(input);
  if (result.ok) return { ok: true };
  throw identityErrors.business(
    result.reason === 'invalid' ? 'captcha_invalid' : 'captcha_unavailable',
    {},
  );
}
