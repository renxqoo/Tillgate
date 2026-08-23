/**
 * 标识绑定:一个标识一个账号;同用户重挂 = 幂等重放(B23:重放不改密码,设初始密码走
 * passwords.reset);他人占用 = identifier_taken。密码策略在此单源校验(B18/D2)。
 * 审计在事务提交后发射(B03)。
 */
import { advisoryLock, runTx } from '@tokenlens/db';
import { auditEvent } from '../domain/audit-events.js';
import { credentialSetLockKey } from '../domain/locks.js';
import { identityErrors } from '../domain/errors.js';
import { assertPasswordPolicy, hashPassword } from '../domain/password.js';
import { assertUserId, normalizeIdentifier, type Identifier } from '../domain/identifier.js';
import type { IdentityUseCaseContext } from './context.js';
import { emitAudit } from './context.js';

export interface RegisterCredentialInput {
  readonly userId: number;
  readonly identifier: Identifier;
  /** 首密码明文(可选;策略单源校验后哈希落 identity_passwords) */
  readonly password?: string;
}

export interface RegisterCredentialResult {
  readonly credentialId: number;
  readonly replayed: boolean;
}

export async function registerCredential(
  ctx: IdentityUseCaseContext,
  input: RegisterCredentialInput,
): Promise<RegisterCredentialResult> {
  const userId = assertUserId(input.userId);
  const identifier = normalizeIdentifier(input.identifier, ctx.guards);
  let passwordHash: string | undefined;
  if (input.password != null) {
    assertPasswordPolicy(input.password, ctx.config.passwordPolicy);
    passwordHash = await hashPassword(input.password);
  }

  const result = await runTx(
    ctx.db,
    async (tx) => {
      await advisoryLock(tx, credentialSetLockKey(userId));
      const outcome = await ctx.credentialStore.registerCredential(tx, { userId, identifier });
      if (outcome.status === 'taken') {
        throw identityErrors.business('identifier_taken', {
          kind: identifier.kind,
          value: identifier.value,
        });
      }
      if (outcome.status === 'created' && passwordHash != null) {
        await ctx.credentialStore.upsertPassword(tx, { userId, passwordHash });
      }
      return { credentialId: outcome.credentialId, replayed: outcome.status === 'replay' };
    },
    ctx.txRetry,
  );

  await emitAudit(
    ctx,
    auditEvent(ctx.clock.now(), {
      actor: 'system',
      action: result.replayed ? 'credential.replay' : 'credential.register',
      targetType: 'credential',
      targetId: result.credentialId,
      detail: { userId, kind: identifier.kind, value: identifier.value },
    }),
  );
  return result;
}
