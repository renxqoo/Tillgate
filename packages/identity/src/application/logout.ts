/**
 * 登出:jti 入黑名单(SETEX 至令牌自然过期);写失败上抛(调用方映射 unavailable,
 * 幂等重试)。缺省未装配 revocation store = 配置错误(invalid_input)。
 */
import { identityErrors } from '../domain/errors.js';
import type { IdentityUseCaseContext } from './context.js';
import { verifySession } from './verify-session.js';

export async function logout(
  ctx: IdentityUseCaseContext,
  token: string,
  realm: string,
): Promise<{ ok: true }> {
  const payload = await verifySession(ctx, token, realm);
  if (ctx.sessionRevocation == null) {
    throw identityErrors.business('invalid_input', {
      field: 'sessionRevocation',
      reason: 'logout requires an assembled sessionRevocation store',
    });
  }
  const remainingSec = Math.max(
    0,
    Math.ceil((payload.exp * 1000 - ctx.clock.now().getTime()) / 1000),
  );
  await ctx.sessionRevocation.revoke(payload.jti, remainingSec);
  return { ok: true };
}
