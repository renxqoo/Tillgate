/** 错误契约：全部错误类型化、code 全局唯一、name 可判别（边界层按 code 翻译 HTTP 的前提） */
import { describe, expect, it } from 'vitest';
import * as errors from '../errors';
import { IdentityError } from '../errors';

describe('错误契约', () => {
  const instances: Array<{ name: string; code: string; error: IdentityError }> = [
    { name: 'InvalidInputError', code: 'invalid_input', error: new errors.InvalidInputError('field', 'detail') },
    { name: 'UnknownIdentifierKindError', code: 'unknown_identifier_kind', error: new errors.UnknownIdentifierKindError('x', ['email']) },
    { name: 'UnknownProviderError', code: 'unknown_provider', error: new errors.UnknownProviderError('x', ['github']) },
    { name: 'UnknownChallengeKindError', code: 'unknown_challenge_kind', error: new errors.UnknownChallengeKindError('x', ['email_code']) },
    { name: 'InvalidIdentifierError', code: 'invalid_identifier', error: new errors.InvalidIdentifierError('email', 'bad') },
    { name: 'InvalidUserIdError', code: 'invalid_user_id', error: new errors.InvalidUserIdError(0) },
    { name: 'WeakPasswordError', code: 'weak_password', error: new errors.WeakPasswordError('too short') },
    { name: 'InvalidCredentialsError', code: 'invalid_credentials', error: new errors.InvalidCredentialsError() },
    { name: 'IdentifierTakenError', code: 'identifier_taken', error: new errors.IdentifierTakenError('email', 'a@b.c') },
    { name: 'ChallengeInvalidError', code: 'challenge_invalid', error: new errors.ChallengeInvalidError('id') },
    { name: 'CodeInvalidError', code: 'code_invalid', error: new errors.CodeInvalidError(3) },
    { name: 'ChallengeCooldownError', code: 'challenge_cooldown', error: new errors.ChallengeCooldownError(500) },
    { name: 'UndeliverableChallengeError', code: 'undeliverable_challenge', error: new errors.UndeliverableChallengeError('k', 'no target') },
    { name: 'DeliveryFailedError', code: 'delivery_failed', error: new errors.DeliveryFailedError('k', 'email') },
    { name: 'OAuthLinkNotFoundError', code: 'oauth_link_not_found', error: new errors.OAuthLinkNotFoundError(1, 'github') },
    { name: 'ProviderAlreadyLinkedError', code: 'provider_already_linked', error: new errors.ProviderAlreadyLinkedError('github', 'user_already_linked') },
    { name: 'LastCredentialError', code: 'last_credential', error: new errors.LastCredentialError(1) },
    { name: 'TotpNotEnrolledError', code: 'totp_not_enrolled', error: new errors.TotpNotEnrolledError(1) },
    { name: 'TotpAlreadyEnrolledError', code: 'totp_already_enrolled', error: new errors.TotpAlreadyEnrolledError(1) },
    { name: 'InvalidTotpCodeError', code: 'invalid_totp_code', error: new errors.InvalidTotpCodeError() },
    { name: 'IdentityInternalError', code: 'identity_internal', error: new errors.IdentityInternalError('op', 'detail') },
  ];

  it('共 21 个错误类；每个都是 IdentityError 实例且 name/code 与声明一致', () => {
    expect(instances).toHaveLength(21);
    for (const { name, code, error } of instances) {
      expect(error).toBeInstanceOf(IdentityError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('code 全局唯一（边界层 switch(code) 的前提）', () => {
    const codes = instances.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('携带结构化字段（allowed/conflict/remainingAttempts/retryAfterMs 供 HTTP 翻译）', () => {
    expect(new errors.UnknownProviderError('fb', ['github', 'google']).allowed).toEqual(['github', 'google']);
    expect(new errors.ProviderAlreadyLinkedError('github', 'provider_identity_taken').conflict).toBe(
      'provider_identity_taken',
    );
    expect(new errors.CodeInvalidError(2).remainingAttempts).toBe(2);
    expect(new errors.ChallengeCooldownError(1_500).retryAfterMs).toBe(1_500);
    expect(new errors.IdentifierTakenError('email', 'a@b.c').value).toBe('a@b.c');
  });
});
