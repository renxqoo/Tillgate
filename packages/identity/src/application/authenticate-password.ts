/**
 * 密码认证:标识+密码 → userId。统一口径:标识不存在、密码错误、账号无密码 →
 * 同一个 invalid_credentials(哑哈希保证等量 scrypt 计算,响应耗时一致——防枚举)。
 * 属主状态检查(封禁等)归消费方编排(DESIGN §1)。审计成败双发(B10)。
 */
import { auditEvent } from '../domain/audit-events.js';
import { identityErrors } from '../domain/errors.js';
import { normalizeIdentifier, type Identifier } from '../domain/identifier.js';
import { verifyPassword } from '../domain/password.js';
import type { IdentityUseCaseContext } from './context.js';
import { emitAudit } from './context.js';

export interface AuthenticatePasswordInput {
  readonly identifier: Identifier;
  readonly password: string;
}

export async function authenticatePassword(
  ctx: IdentityUseCaseContext,
  input: AuthenticatePasswordInput,
): Promise<{ userId: number }> {
  const identifier = normalizeIdentifier(input.identifier, ctx.guards);
  const row = await ctx.credentialStore.findPasswordHashByIdentifier(ctx.db, identifier);
  const ok = await verifyPassword(
    typeof input.password === 'string' ? input.password : '',
    row?.passwordHash ?? null,
  );
  if (!row || !ok) {
    await emitAudit(
      ctx,
      auditEvent(ctx.clock.now(), {
        actor: 'anonymous',
        action: 'credential.authenticate',
        targetType: 'credential',
        targetId: `${identifier.kind}:${identifier.value}`,
        detail: { outcome: 'failure' },
      }),
    );
    throw identityErrors.business('invalid_credentials', { kind: identifier.kind });
  }
  await emitAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: `user:${row.userId}`,
      action: 'credential.authenticate',
      targetType: 'user',
      targetId: row.userId,
      detail: { outcome: 'success' },
    }),
  );
  return { userId: row.userId };
}
