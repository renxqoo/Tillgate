/**
 * 用例上下文(facade 装配产物;一一动词一文件的公共依赖面)。
 * 审计发射契约(B03 修复):emitAudit 仅在事务提交后调用;record 失败降级 warn
 * (审计是观察事实,不反噬业务结果)。
 * 本文件是纯类型 + 观察助手——装配(缺省 adapter 组装)归根装配面 identity.ts。
 */
import type { Db, TxRetryPolicy } from '@tokenlens/db';
import type { ResolvedIdentityConfig } from '../domain/config.js';
import type { ValidationGuards } from '../domain/identifier.js';
import type { IdentityAuditEvent } from '../domain/audit-events.js';
import type { Clock } from '../ports/clock.js';
import type { LoggerLike } from '../ports/logger.js';
import type { AuditPort } from '../ports/audit.js';
import type { CredentialStore } from '../ports/credential-store.js';
import type { ChallengeStore } from '../ports/challenge-store.js';
import type { MfaStore } from '../ports/mfa-store.js';
import type { OAuthStore } from '../ports/oauth-store.js';
import type { AnchorStore } from '../ports/anchor-store.js';
import type { Mailer } from '../ports/mailer.js';
import type { Captcha } from '../ports/captcha.js';
import type { SessionTokens } from '../ports/session-tokens.js';
import type { SessionRevocationStore } from '../ports/session-revocation-store.js';
import type { OAuthStateStore } from '../ports/oauth-state-store.js';
import type { OAuthProvider } from '../ports/oauth-provider.js';
import type { SecretCipher } from '../ports/secret-cipher.js';

export interface IdentityUseCaseContext {
  readonly db: Db;
  readonly txRetry: TxRetryPolicy;
  readonly clock: Clock;
  readonly logger: LoggerLike;
  readonly config: ResolvedIdentityConfig;
  readonly guards: ValidationGuards;
  readonly credentialStore: CredentialStore;
  readonly challengeStore: ChallengeStore;
  readonly mfaStore: MfaStore;
  readonly oauthStore: OAuthStore;
  readonly anchorStore: AnchorStore;
  readonly tokens: SessionTokens;
  readonly oauthProviders: Readonly<Record<string, OAuthProvider>>;
  readonly mailer?: Mailer;
  readonly captcha?: Captcha;
  readonly sessionRevocation?: SessionRevocationStore;
  readonly oauthStateStore?: OAuthStateStore;
  readonly cipher?: SecretCipher;
  readonly auditSink?: AuditPort;
}

export async function emitAudit(
  ctx: IdentityUseCaseContext,
  event: IdentityAuditEvent,
): Promise<void> {
  if (ctx.auditSink == null) return;
  try {
    await ctx.auditSink.record(event);
  } catch (error) {
    ctx.logger.warn(
      { err: (error as Error).message, action: event.action },
      'identity audit emit failed',
    );
  }
}
