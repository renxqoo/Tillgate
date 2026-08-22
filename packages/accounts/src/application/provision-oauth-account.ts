/**
 * OAuth 账号 find-or-create(v1 oauth.service 语义):同 (issuer,subject) 幂等建号;
 * 竞态撞唯一键走 exists 分支回查(23505 兜底)。displayName 兜底「用户{subject 前 6}」。
 * status≠0 的拒绝归调用方(identity 防枚举口径)。
 */
import { runTx } from '@tokenlens/db';
import { clampDisplayName, oauthDisplayNameFallback } from '../domain/user.js';
import { normalizeValidEmail } from '../domain/fields.js';
import type { UserRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export interface ProvisionOAuthResult {
  readonly user: UserRecord;
  readonly created: boolean;
}

export async function provisionOAuthAccount(
  ctx: UseCaseContext,
  input: { issuer: string; subject: string; email?: string; displayName?: string },
): Promise<ProvisionOAuthResult> {
  // email 由调用方选取已验证邮箱;此处规范化,形状不合法按无邮箱落库(v1 不校验语义)
  const email = input.email !== undefined ? normalizeValidEmail(input.email) : null;
  const displayName =
    input.displayName !== undefined && input.displayName.trim().length > 0
      ? clampDisplayName(input.displayName)
      : oauthDisplayNameFallback(input.subject);

  const existing = await ctx.store.findOAuthUser(ctx.db, input.issuer, input.subject);
  if (existing !== null) return { user: existing, created: false };

  return runTx(
    ctx.db,
    async (tx) => {
      const result = await ctx.store.insertOAuthUser(tx, {
        issuer: input.issuer,
        subject: input.subject,
        email,
        displayName,
      });
      if (result.status === 'created') return { user: result.user, created: true };
      const reread = await ctx.store.findOAuthUser(tx, input.issuer, input.subject);
      if (reread === null) throw new Error('oauth user disappeared after unique conflict');
      return { user: reread, created: false };
    },
    ctx.txRetry,
  );
}
