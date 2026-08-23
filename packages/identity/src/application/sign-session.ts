/** 会话签发:realm 配置(issuer/密钥/TTL)装配注入;ttlSec 可覆盖(界内)。 */
import { identityErrors } from '../domain/errors.js';
import { guardRealm } from '../domain/identifier.js';
import { assertSessionTtlSec } from '../domain/session.js';
import type { IdentityUseCaseContext } from './context.js';

export interface SignSessionInput {
  readonly realm: string;
  readonly subjectId: number;
  readonly ttlSec?: number;
}

export async function signSession(
  ctx: IdentityUseCaseContext,
  input: SignSessionInput,
): Promise<string> {
  const realm = guardRealm(input.realm, ctx.guards);
  const session = ctx.config.sessions[realm];
  if (session == null) {
    throw identityErrors.business('unknown_realm', { realm });
  }
  const ttlSec = input.ttlSec != null ? assertSessionTtlSec(input.ttlSec) : session.ttlSec;
  return ctx.tokens.sign({ realm, subjectId: input.subjectId, ttlSec });
}
