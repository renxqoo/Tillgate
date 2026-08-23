/**
 * @tokenlens/identity 公共出口:facade、用例出入参、领域词表与纯函数、错误目录、
 * port 契约类型(装配桥接用)。Db/DbTx/drizzle 行类型/adapter 一律不出(架构测试锁死)。
 */
export { createIdentity, type CreateIdentityParams, type Identity } from './identity.js';

export { identityErrors } from './domain/errors.js';
export {
  BUILTIN_IDENTIFIER_KINDS,
  VOCAB_RE,
  type IdentifierKind,
  type Identifier,
  type NormalizedIdentifier,
  type ValidationGuards,
} from './domain/identifier.js';
export {
  PASSWORD_HASH_RE,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  hashPassword,
  verifyPassword,
  assertPasswordPolicy,
  type PasswordPolicy,
} from './domain/password.js';
export {
  CHALLENGE_BOUNDS,
  type DeliveryChannel,
  type ChallengeTarget,
} from './domain/challenge.js';
export { AUDIT_ACTIONS, type AuditAction, type IdentityAuditEvent } from './domain/audit-events.js';
export {
  type IdentityConfigInput,
  type ChallengeConfig,
  type TotpConfig,
  type OAuthProviderCredentials,
  type OAuthEndpointsOverride,
} from './domain/config.js';
export {
  type SessionPayload,
  type SessionRealmConfig,
  type SessionVerifyResult,
} from './domain/session.js';
export { credentialSetLockKey, challengeLockKey } from './domain/locks.js';

export type { Clock } from './ports/clock.js';
export type { LoggerLike } from './ports/logger.js';
export type { AuditPort } from './ports/audit.js';
export type { Mailer } from './ports/mailer.js';
export type { Captcha } from './ports/captcha.js';
export type { SecretCipher } from './ports/secret-cipher.js';
export type { SessionTokens } from './ports/session-tokens.js';
export type { SessionRevocationStore } from './ports/session-revocation-store.js';
export type { OAuthProvider, OAuthProfile } from './ports/oauth-provider.js';
export type { OAuthStateStore, OAuthStatePayload } from './ports/oauth-state-store.js';
export type { CredentialStore, RegisterCredentialOutcome } from './ports/credential-store.js';
export type {
  ChallengeStore,
  BeginChallengeOutcome,
  StoredChallengeTarget,
} from './ports/challenge-store.js';
export type { MfaStore, TotpRow } from './ports/mfa-store.js';
export type { OAuthStore, LinkOutcome, UnlinkOutcome } from './ports/oauth-store.js';
export type { AnchorStore } from './ports/anchor-store.js';

export type {
  RegisterCredentialInput,
  RegisterCredentialResult,
} from './application/register-credential.js';
export type { AuthenticatePasswordInput } from './application/authenticate-password.js';
export type { ChangePasswordInput } from './application/change-password.js';
export type { ResetPasswordInput } from './application/reset-password.js';
export type { BeginChallengeInput, BeginChallengeResult } from './application/begin-challenge.js';
export type {
  VerifyChallengeInput,
  VerifyChallengeResult,
} from './application/verify-challenge.js';
export type { EnrollTotpResult } from './application/enroll-totp.js';
export type { LinkOAuthResult } from './application/link-oauth.js';
export type { OAuthAuthorizeInput } from './application/oauth-authorize.js';
export type { OAuthCallbackInput, OAuthCallbackResult } from './application/oauth-callback.js';
export type { SignSessionInput } from './application/sign-session.js';

export {
  renderLoginCodeEmail,
  type MailBrand,
  type LoginCodeEmailContext,
} from './templates/login-code-email.js';
