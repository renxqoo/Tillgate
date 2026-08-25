/**
 * 用例上下文(facade 装配产物;一一动词一文件的公共依赖面)。
 * 审计契约(§5.4 事务参与,替代 B03 的提交后 warn 形态):
 * - auditWithinTx:业务事务提交前于同一 tx 内写入(推荐路径)——回滚即无审计行,
 *   record 失败随业务事务回滚,不吞错(安全审计不得降级)。
 * - recordAudit:无业务事务的路径(纯读拒绝/单语句 CAS 后)用独立连接单写,失败抛错。
 * 本文件是纯类型 + 观察助手——装配(缺省 adapter 组装)归根装配面 identity.ts。
 */
import type { Db, DbLike, TxRetryPolicy } from '@tillgate/db';
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
  /** OAuth provider 适配器解析(每次动词调用解析当前快照;装配覆盖件优先,未配置 = null) */
  readonly oauthProvider: (name: string) => OAuthProvider | null;
  readonly mailer?: Mailer;
  readonly captcha?: Captcha;
  readonly sessionRevocation?: SessionRevocationStore;
  readonly oauthStateStore?: OAuthStateStore;
  readonly cipher?: SecretCipher;
  readonly auditSink?: AuditPort;
}

export async function auditWithinTx(
  tx: DbLike,
  ctx: IdentityUseCaseContext,
  event: IdentityAuditEvent,
): Promise<void> {
  if (ctx.auditSink == null) return;
  // 不吞错:审计写失败 → 业务事务回滚(§5.4 安全审计不降级)
  await ctx.auditSink.record(tx, event);
}

export async function recordAudit(
  ctx: IdentityUseCaseContext,
  event: IdentityAuditEvent,
): Promise<void> {
  if (ctx.auditSink == null) return;
  // 无业务事务路径:独立连接单写,失败抛错(调用方观察,不降级 warn)
  await ctx.auditSink.record(ctx.db, event);
}
