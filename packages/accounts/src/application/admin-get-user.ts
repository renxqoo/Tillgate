/** 管理面单查(白名单投影 + 费率卡名;钱包富化归 app 组合) */
import { AccountsErrors } from '../domain/errors.js';
import type { UserProfile } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function adminGetUser(ctx: UseCaseContext, userId: number): Promise<UserProfile> {
  const profile = await ctx.store.getUserProfile(ctx.db, userId);
  if (profile === null) throw AccountsErrors.business('user_not_found', { userId });
  return profile;
}
