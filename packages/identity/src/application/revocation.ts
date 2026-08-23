/**
 * 会话吊销锚点(B01 收敛:单一真相 = identity_session_anchors,realm 泛化)。
 * advance = 原语(改密/重置内部同事务调用);revoke = 带审计的动词;
 * validAt = 读校验(realm 白名单 fail-closed,B08 修复——v1 读路径 fail-open)。
 */
import { auditEvent } from '../domain/audit-events.js';
import { assertUserId, guardRealm } from '../domain/identifier.js';
import { iatMsOf } from '../domain/session.js';
import type { IdentityUseCaseContext } from './context.js';
import { emitAudit } from './context.js';

export async function advanceAnchor(
  ctx: IdentityUseCaseContext,
  input: { realm: string; userId: number; at?: Date },
): Promise<string> {
  const realm = guardRealm(input.realm, ctx.guards);
  const userId = assertUserId(input.userId);
  return ctx.anchorStore.advanceAnchor(ctx.db, {
    realm,
    userId,
    ...(input.at != null ? { at: input.at } : {}),
  });
}

export async function revokeSessions(
  ctx: IdentityUseCaseContext,
  input: { realm: string; userId: number; at?: Date },
): Promise<{ invalidBefore: string }> {
  const realm = guardRealm(input.realm, ctx.guards);
  const userId = assertUserId(input.userId);
  const invalidBefore = await ctx.anchorStore.advanceAnchor(ctx.db, {
    realm,
    userId,
    ...(input.at != null ? { at: input.at } : {}),
  });
  await emitAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: 'admin',
      action: 'session.revoke',
      targetType: 'user',
      targetId: userId,
      detail: { realm, invalidBefore },
    }),
  );
  return { invalidBefore };
}

export async function sessionValidAt(
  ctx: IdentityUseCaseContext,
  input: { realm: string; userId: number; iat: Date | number },
): Promise<boolean> {
  const realm = guardRealm(input.realm, ctx.guards);
  const userId = assertUserId(input.userId);
  const iatMs = iatMsOf(input.iat);
  const anchor = await ctx.anchorStore.readAnchor(ctx.db, { realm, userId });
  if (anchor == null) return true;
  return iatMs >= Date.parse(anchor);
}
