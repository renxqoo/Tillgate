/**
 * 改密码:验旧密 → 换哈希 + 吊销线推进(同一事务)。验旧密收进
 * advisoryLock 临界区——旧密的读与改之间不存在并发 reset 覆盖窗口(scrypt 在
 * 每用户锁内执行,无全局争用)。无密码账号(OAuth-only)走 reset。
 */
import { advisoryLock, runTx, type DbTx } from '@tillgate/db';
import { DefectError } from '@tillgate/errors';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../domain/password.js';
import { assertUserId, guardRealm } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';
import { auditWithinTx } from './context.js';

export interface ChangePasswordInput {
  readonly userId: number;
  /** 吊销线推进的 realm(改哪面密码下哪面的线) */
  readonly realm: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

/** 锁内改密临界区:验旧密 → 换哈希 → 吊销线推进 → 同事务审计(回滚即无审计行) */
async function changePasswordWithinLock(
  ctx: IdentityUseCaseContext,
  tx: DbTx,
  args: { userId: number; realm: string; currentPassword: string; newHash: string },
): Promise<string> {
  await advisoryLock(tx, credentialSetLockKey(args.userId));
  const stored = await ctx.credentialStore.loadPasswordHash(tx, args.userId);
  if (stored == null) {
    throw identityErrors.business('invalid_credentials', { realm: args.realm });
  }
  const currentOk = await verifyPassword(args.currentPassword, stored);
  if (!currentOk) {
    throw identityErrors.business('invalid_credentials', { realm: args.realm });
  }
  const updated = await ctx.credentialStore.updatePassword(tx, {
    userId: args.userId,
    passwordHash: args.newHash,
  });
  if (!updated) {
    throw new DefectError('password row disappeared mid-transaction', 'identity.defect', {
      operation: 'change_password',
    });
  }
  // 锚线取应用时钟（与令牌 iatMs 同域）：DB now() 跨时钟域（app 与 DB 不同宿主时
  // 有毫秒级偏差）会把改密后当场重签的新令牌误杀在锚线下。
  const before = await ctx.anchorStore.advanceAnchor(tx, {
    realm: args.realm,
    userId: args.userId,
    at: ctx.clock.now(),
  });
  // 安全审计同事务写入:回滚即无审计行,写入失败随事务回滚
  await auditWithinTx(
    tx,
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: `user:${args.userId}`,
      action: 'password.change',
      targetType: 'user',
      targetId: args.userId,
      detail: { realm: args.realm },
    }),
  );
  return before;
}

export async function changePassword(
  ctx: IdentityUseCaseContext,
  input: ChangePasswordInput,
): Promise<{ invalidBefore: string }> {
  const userId = assertUserId(input.userId);
  const realm = guardRealm(input.realm, ctx.guards);
  assertPasswordPolicy(input.newPassword, ctx.config.passwordPolicy);
  if (typeof input.currentPassword !== 'string') {
    throw identityErrors.business('invalid_credentials', { realm });
  }
  const newHash = await hashPassword(input.newPassword);

  const invalidBefore = await runTx(
    ctx.db,
    (tx) =>
      changePasswordWithinLock(ctx, tx, {
        userId,
        realm,
        currentPassword: input.currentPassword,
        newHash,
      }),
    ctx.txRetry,
  );

  return { invalidBefore };
}
