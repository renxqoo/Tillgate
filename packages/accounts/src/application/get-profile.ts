/** 用户资料读(含费率卡名;钱包富化归 app 组合,G1) */
import { AccountsErrors } from '../domain/errors.js';
import type { UserProfile } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function getProfile(ctx: UseCaseContext, userId: number): Promise<UserProfile> {
  const profile = await ctx.store.getUserProfile(ctx.db, userId);
  if (profile === null) throw AccountsErrors.business('user_not_found', { userId });
  return profile;
}
