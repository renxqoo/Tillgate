/**
 * 会话校验链(silent null 面,app 中间件消费):验签 → jti 黑名单(读故障
 * fail-open + warn)→ 锚点线(iatMs < invalid_before 即失效;无锚点全有效)。
 * 属主回查 + status 检查不在本包(归 accounts 经 app 编排)。
 */
import { iatMsOf, type SessionPayload } from '../domain/session.js';
import { guardRealm } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';

export async function validateSession(
  ctx: IdentityUseCaseContext,
  token: string,
  realm: string,
): Promise<SessionPayload | null> {
  const guarded = guardRealm(realm, ctx.guards);
  const result = await ctx.tokens.verify(token, guarded);
  if (!result.ok) return null;
  const { payload } = result;
  if (ctx.sessionRevocation != null) {
    let revoked: boolean;
    try {
      revoked = await ctx.sessionRevocation.isRevoked(payload.jti);
    } catch (error) {
      // 读故障 fail-open + warn(吊销是增强层,主防线是属主回查与锚点线)
      ctx.logger.warn(
        { err: (error as Error).message, jti: payload.jti },
        'session revocation lookup failed (fail-open; owner checks and anchor line remain authoritative)',
      );
      revoked = false;
    }
    if (revoked) return null;
  }
  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const anchor = await ctx.anchorStore.readAnchor(ctx.db, { realm: guarded, userId });
  if (anchor == null) return payload;
  const iatMs = iatMsOf(payload.iatMs ?? payload.iat * 1000);
  return iatMs >= Date.parse(anchor) ? payload : null;
}
