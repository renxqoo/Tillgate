/** 身份内核错误类型（错误语义分级：输入非法 ≠ 认证失败 ≠ 状态冲突 ≠ 词表越界） */

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** 运行时输入/配置非法（字段级定位；调用方 bug，不应重试） */
export class InvalidInputError extends IdentityError {
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`invalid ${field}: ${detail}`, 'invalid_input');
    this.name = 'InvalidInputError';
  }
}

/** 标识类型不在白名单（fail-closed；allowed 携带全部合法值） */
export class UnknownIdentifierKindError extends IdentityError {
  constructor(
    readonly kind: string,
    readonly allowed: readonly string[],
  ) {
    super(`unknown identifier kind '${kind}' (allowed: ${allowed.join(', ') || 'none'})`, 'unknown_identifier_kind');
    this.name = 'UnknownIdentifierKindError';
  }
}

/** OAuth provider 不在白名单 */
export class UnknownProviderError extends IdentityError {
  constructor(
    readonly provider: string,
    readonly allowed: readonly string[],
  ) {
    super(`unknown provider '${provider}' (allowed: ${allowed.join(', ') || 'none'})`, 'unknown_provider');
    this.name = 'UnknownProviderError';
  }
}

/** 挑战类型不在白名单 */
export class UnknownChallengeKindError extends IdentityError {
  constructor(
    readonly kind: string,
    readonly allowed: readonly string[],
  ) {
    super(`unknown challenge kind '${kind}' (allowed: ${allowed.join(', ') || 'none'})`, 'unknown_challenge_kind');
    this.name = 'UnknownChallengeKindError';
  }
}

/** 标识值形状非法（如坏邮箱/乱码手机号；kind 归一化之后才到这层） */
export class InvalidIdentifierError extends IdentityError {
  constructor(
    readonly kind: string,
    detail: string,
  ) {
    super(`invalid ${kind} identifier: ${detail}`, 'invalid_identifier');
    this.name = 'InvalidIdentifierError';
  }
}

export class InvalidUserIdError extends IdentityError {
  constructor(userId: unknown) {
    super(`user id must be a positive integer, got ${JSON.stringify(userId)}`, 'invalid_user_id');
    this.name = 'InvalidUserIdError';
  }
}

/** 密码不满足策略（reason 供展示） */
export class WeakPasswordError extends IdentityError {
  constructor(readonly reason: string) {
    super(`weak password: ${reason}`, 'weak_password');
    this.name = 'WeakPasswordError';
  }
}

/**
 * 认证失败（统一口径）：标识不存在、密码错误、账号无密码 —— 同一错误同一文案，
 * 不向调用方泄露「用户是否存在」（防枚举）。重试与否由业务限流决定。
 */
export class InvalidCredentialsError extends IdentityError {
  constructor() {
    super('invalid identifier or password', 'invalid_credentials');
    this.name = 'InvalidCredentialsError';
  }
}

/** 标识已被其他用户占用（注册/挂凭据并发由唯一索引兜底到这里） */
export class IdentifierTakenError extends IdentityError {
  constructor(
    readonly kind: string,
    readonly value: string,
  ) {
    super(`${kind} identifier '${value}' is already taken`, 'identifier_taken');
    this.name = 'IdentifierTakenError';
  }
}

/**
 * 挑战不可用（统一口径）：不存在 / 已消费 / 已作废 / 已过期 / 错次超限。
 * 不细分原因——细分即向探测方泄露挑战状态。
 */
export class ChallengeInvalidError extends IdentityError {
  constructor(readonly challengeId: string) {
    super(`challenge ${challengeId} is invalid (consumed, aborted, expired, exhausted or unknown)`, 'challenge_invalid');
    this.name = 'ChallengeInvalidError';
  }
}

/** 验证码错误（挑战仍在，可重试；remainingAttempts 为剩余次数） */
export class CodeInvalidError extends IdentityError {
  constructor(readonly remainingAttempts: number) {
    super(`code is incorrect, ${remainingAttempts} attempt(s) left`, 'code_invalid');
    this.name = 'CodeInvalidError';
  }
}

/** 同目标重发冷却中（retryAfterMs 供 Retry-After 头换算） */
export class ChallengeCooldownError extends IdentityError {
  constructor(readonly retryAfterMs: number) {
    super(`challenge cooldown, retry after ${retryAfterMs}ms`, 'challenge_cooldown');
    this.name = 'ChallengeCooldownError';
  }
}

/** 挑战目标无法投递（用户无 email/phone 凭据、username 目标等）——发送前失败 */
export class UndeliverableChallengeError extends IdentityError {
  constructor(readonly kind: string, detail: string) {
    super(`challenge kind '${kind}' has no deliverable target: ${detail}`, 'undeliverable_challenge');
    this.name = 'UndeliverableChallengeError';
  }
}

/** 验证码投递失败：挑战已作废，调用方应提示用户重发 */
export class DeliveryFailedError extends IdentityError {
  constructor(readonly kind: string, readonly channel: string) {
    super(`failed to deliver ${kind} code via ${channel}`, 'delivery_failed');
    this.name = 'DeliveryFailedError';
  }
}

export class OAuthLinkNotFoundError extends IdentityError {
  constructor(
    readonly userId: number,
    readonly provider: string,
  ) {
    super(`user ${userId} has no '${provider}' link`, 'oauth_link_not_found');
    this.name = 'OAuthLinkNotFoundError';
  }
}

/**
 * OAuth 绑定冲突：
 *   provider_identity_taken = 该三方身份已被其他用户绑定（防劫持不变量的业务面）
 *   user_already_linked     = 该用户已绑定此 provider（一人一 provider 一绑定）
 */
export class ProviderAlreadyLinkedError extends IdentityError {
  constructor(
    readonly provider: string,
    readonly conflict: 'provider_identity_taken' | 'user_already_linked',
  ) {
    super(
      conflict === 'provider_identity_taken'
        ? `provider '${provider}' identity is already linked to another user`
        : `user already has a '${provider}' link`,
      'provider_already_linked',
    );
    this.name = 'ProviderAlreadyLinkedError';
  }
}

/** 删除后会失去全部登录方式（凭据集非空不变量的业务面） */
export class LastCredentialError extends IdentityError {
  constructor(readonly userId: number) {
    super(`cannot remove the last login method for user ${userId}`, 'last_credential');
    this.name = 'LastCredentialError';
  }
}

export class TotpNotEnrolledError extends IdentityError {
  constructor(readonly userId: number) {
    super(`user ${userId} has no confirmed TOTP enrollment`, 'totp_not_enrolled');
    this.name = 'TotpNotEnrolledError';
  }
}

export class TotpAlreadyEnrolledError extends IdentityError {
  constructor(readonly userId: number) {
    super(`user ${userId} already has a confirmed TOTP enrollment`, 'totp_already_enrolled');
    this.name = 'TotpAlreadyEnrolledError';
  }
}

/** MFA 码错误（TOTP 或恢复码；统一口径，remainingAttempts 不泄露——TOTP 无次数语义） */
export class InvalidTotpCodeError extends IdentityError {
  constructor() {
    super('invalid mfa code', 'invalid_totp_code');
    this.name = 'InvalidTotpCodeError';
  }
}

/** 防御点兜底：唯一约束冲突读回缺行等「不可能分支」——亮红灯而非静默 */
export class IdentityInternalError extends IdentityError {
  constructor(readonly operation: string, detail: string) {
    super(`internal invariant broken at ${operation}: ${detail}`, 'identity_internal');
    this.name = 'IdentityInternalError';
  }
}
