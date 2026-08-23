/** 会话验签(throw 面):失败抛 invalid_token(context 带 reason)。 */
import { identityErrors } from '../domain/errors.js';
import { guardRealm } from '../domain/identifier.js';
import type { SessionPayload } from '../domain/session.js';
import type { IdentityUseCaseContext } from './context.js';

export async function verifySession(
  ctx: IdentityUseCaseContext,
  token: string,
  realm: string,
): Promise<SessionPayload> {
  const guarded = guardRealm(realm, ctx.guards);
  const result = await ctx.tokens.verify(token, guarded);
  if (!result.ok) {
    throw identityErrors.business('invalid_token', { realm: guarded, reason: result.reason });
  }
  return result.payload;
}
