/**
 * 本地账号建号(G4/G5 交界:凭据/挑战归 identity;本用例只建资料行,不触碰
 * password_hash 列)。displayName 缺省=email 本地部分截 64(v1 insertLocalUser)。
 */
import { runTx } from '@tokenlens/db';
import { AccountsErrors } from '../domain/errors.js';
import { normalizeValidEmail } from '../domain/fields.js';
import { localDisplayNameFallback } from '../domain/user.js';
import type { UserRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function provisionLocalAccount(
  ctx: UseCaseContext,
  input: { email: string; displayName?: string },
): Promise<UserRecord> {
  const email = normalizeValidEmail(input.email);
  if (email === null) throw AccountsErrors.business('email_invalid', { email: input.email });

  let displayName: string;
  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (name.length < 1 || name.length > 64) {
      throw AccountsErrors.business('display_name_invalid');
    }
    displayName = name;
  } else {
    displayName = localDisplayNameFallback(email);
  }

  return runTx(
    ctx.db,
    async (tx) => {
      const result = await ctx.store.insertLocalUser(tx, { email, displayName });
      if (result.status === 'email_taken') {
        throw AccountsErrors.business('email_taken', { email });
      }
      return result.user;
    },
    ctx.txRetry,
  );
}
