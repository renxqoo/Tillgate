/** (provider, subject) → userId | null(find-or-create 编排中的 find 半程;建号归 accounts) */
import { assertOAuthSubject, guardProvider } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';

export async function findOAuthUser(
  ctx: IdentityUseCaseContext,
  input: { provider: string; subject: string },
): Promise<number | null> {
  const provider = guardProvider(input.provider, ctx.guards);
  const subject = assertOAuthSubject(input.subject);
  return ctx.oauthStore.findUser(ctx.db, { provider, subject });
}
