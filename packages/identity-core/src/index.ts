/**
 * @ai-gateway/identity-core — 通用身份内核（业务无关）。
 *
 * 与旧 @ai-gateway/identity（无状态算法工具箱：JWT 签验/cookie/scrypt/Redis 限流）分工：
 * 本包管「有状态安全事实」——凭据绑定、统一挑战（一次性消费）、OAuth 绑定、
 * TOTP+恢复码、会话吊销锚点；不变量全部下沉 DB（唯一索引/CHECK/advisory lock/CAS）。
 *
 * 消费方自带 users 表：本包不建用户行、不 FK——userId 由消费方分配后挂凭据进来。
 * 表结构：schema.ts 七表；建表：provision(db) 或 provisionSql() 收进自己的迁移管线。
 */

// 装配与契约
export { createIdentity } from './identity.js';
export type {
  ChallengeTarget,
  CreateIdentityOptions,
  ResolvedChallengeTarget,
} from './types.js';
export type {
  Identifier,
  IdentifierKind,
  Identity,
  IdentityAuditEvent,
  IdentityEffects,
  DeliveryChannel,
  NormalizedIdentifier,
  PasswordPolicy,
  SecretCipher,
  ChallengeConfig,
  TotpConfig,
} from './types.js';
export type {
  RegisterCredentialInput,
  RegisterCredentialResult,
  AuthenticateInput,
  ChangePasswordInput,
  ResetPasswordInput,
  PasswordMutationResult,
  BeginChallengeInput,
  BeginChallengeResult,
  VerifyChallengeInput,
  VerifyChallengeResult,
  AbortChallengeInput,
  AbortChallengeResult,
  FindOAuthUserInput,
  LinkOAuthInput,
  LinkOAuthResult,
  UnlinkOAuthInput,
  UnlinkOAuthResult,
  EnrollTotpInput,
  EnrollTotpResult,
  ConfirmTotpInput,
  ConfirmTotpResult,
  VerifyMfaInput,
  VerifyMfaResult,
  DisableTotpInput,
  RevokeSessionsInput,
  RevokeSessionsResult,
  SessionValidAtInput,
} from './types.js';

// 错误（全部类型化；code 全局唯一，边界层按 code 翻译 HTTP）
export {
  IdentityError,
  InvalidInputError,
  UnknownIdentifierKindError,
  UnknownProviderError,
  UnknownChallengeKindError,
  InvalidIdentifierError,
  InvalidUserIdError,
  WeakPasswordError,
  InvalidCredentialsError,
  IdentifierTakenError,
  ChallengeInvalidError,
  CodeInvalidError,
  ChallengeCooldownError,
  UndeliverableChallengeError,
  DeliveryFailedError,
  OAuthLinkNotFoundError,
  ProviderAlreadyLinkedError,
  LastCredentialError,
  TotpNotEnrolledError,
  TotpAlreadyEnrolledError,
  InvalidTotpCodeError,
  IdentityInternalError,
} from './errors.js';

// schema 与建表
export {
  provision,
  provisionSql,
  deprovision,
  identityCredentials,
  identityPasswords,
  identityOauthLinks,
  identityChallenges,
  identityTotp,
  identityRecoveryCodes,
  identitySessionAnchors,
} from './schema.js';

// 会话吊销（独立工具：中间件校验链 / 业务事务内推进锚点直接复用）
export { advanceAnchor, sessionValidAt } from './revocation.js';
export { DEFAULT_REALM } from './validation.js';
export type { AnyPgDatabase, DbLike, Tx } from './internal.js';

// 密码工具（registerCredential 入参需要 hashPassword 产物；策略校验供业务注册前自查）
export {
  hashPassword,
  verifyPassword,
  assertPasswordPolicy,
  PASSWORD_HASH_RE,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
} from './password.js';
