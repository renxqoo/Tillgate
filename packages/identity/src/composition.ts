/**
 * 装配子入口(内部 workspace 契约,非公开 API——总纲 §5.3/§5.4):
 * 业务能力包(accounts 的 adapter)或 app assembly 需要与自身业务状态**同一事务**
 * 注册凭据时(建号+挂标识原子),经此 bridge 参与;DbTx 不进根 facade。
 * 审计(§5.4 事务参与):bridge 在调用方事务内经 auditSink 直写——提交即落库、
 * 回滚即无审计行(不再返回 auditEvents 由调用方提交后冲洗)。
 * 仅 app assembly、迁移脚本与 adapter 集成测试可引用本入口。
 */
import { advisoryLock, type DbTx } from '@tokenlens/db';
import { auditEvent } from './domain/audit-events.js';
import { credentialSetLockKey } from './domain/locks.js';
import { identityErrors } from './domain/errors.js';
import { assertPasswordPolicy, hashPassword, PASSWORD_HASH_RE } from './domain/password.js';
import { assertUserId, normalizeIdentifier, type Identifier } from './domain/identifier.js';
import { postgresIdentityStore } from './adapters/postgres/identity-store';
import type { Clock } from './ports/clock.js';
import type { AuditPort } from './ports/audit.js';
import type { CredentialStore } from './ports/credential-store.js';
import type { ValidationGuards } from './domain/identifier.js';
import type { PasswordPolicy } from './domain/password.js';

// 存储 port 契约(可替换实现/装配桥接面,方法首参 DbLike 参与调用方事务)——
// §5.3:不从根出口导出,仅装配/迁移/adapter 集成测试可引用本入口
export type { CredentialStore, RegisterCredentialOutcome } from './ports/credential-store.js';
export type {
  ChallengeStore,
  BeginChallengeOutcome,
  StoredChallengeTarget,
} from './ports/challenge-store.js';
export type { MfaStore, TotpRow } from './ports/mfa-store.js';
export type { OAuthStore, LinkOutcome, UnlinkOutcome } from './ports/oauth-store.js';
export type { AnchorStore } from './ports/anchor-store.js';

export interface BridgeRegisterCredentialInput {
  readonly userId: number;
  readonly identifier: Identifier;
  /** 首密码明文(可选;策略单源校验)或预哈希哈希(须为本包 scrypt 格式) */
  readonly password?: string;
  readonly passwordHash?: string;
}

export interface BridgeRegisterCredentialResult {
  readonly credentialId: number;
  readonly replayed: boolean;
}

export interface IdentityWithinTx {
  /** 与调用方事务同拍的标识注册(锁与写入都在调用方事务内;冲突随事务回滚) */
  registerCredential(input: BridgeRegisterCredentialInput): Promise<BridgeRegisterCredentialResult>;
}

export function identityWithinTx(
  tx: DbTx,
  env: {
    readonly clock: Clock;
    readonly guards: ValidationGuards;
    readonly passwordPolicy: PasswordPolicy;
    /** 事务参与审计 sink(§5.4):提供时审计随调用方事务原子落库,失败随事务回滚 */
    readonly auditSink?: AuditPort;
    readonly credentialStore?: CredentialStore;
  },
): IdentityWithinTx {
  const store = env.credentialStore ?? postgresIdentityStore;
  return {
    async registerCredential(input) {
      const userId = assertUserId(input.userId);
      const identifier = normalizeIdentifier(input.identifier, env.guards);
      let passwordHash: string | undefined;
      if (input.password != null) {
        assertPasswordPolicy(input.password, env.passwordPolicy);
        passwordHash = await hashPassword(input.password);
      } else if (input.passwordHash != null) {
        if (!PASSWORD_HASH_RE.test(input.passwordHash)) {
          throw identityErrors.business('invalid_input', {
            field: 'passwordHash',
            reason: 'must be produced by hashPassword (scrypt:N:r:p:<saltHex>:<hashHex>)',
          });
        }
        passwordHash = input.passwordHash;
      }

      await advisoryLock(tx, credentialSetLockKey(userId));
      const outcome = await store.registerCredential(tx, { userId, identifier });
      if (outcome.status === 'taken') {
        throw identityErrors.business('identifier_taken', {
          kind: identifier.kind,
          value: identifier.value,
        });
      }
      if (outcome.status === 'created' && passwordHash != null) {
        await store.upsertPassword(tx, { userId, passwordHash });
      }
      const replayed = outcome.status === 'replay';
      if (env.auditSink != null) {
        await env.auditSink.record(
          tx,
          auditEvent(env.clock.now(), {
            actor: 'system',
            action: replayed ? 'credential.replay' : 'credential.register',
            targetType: 'credential',
            targetId: outcome.credentialId,
            detail: { userId, kind: identifier.kind, value: identifier.value },
          }),
        );
      }
      return {
        credentialId: outcome.credentialId,
        replayed,
      };
    },
  };
}
