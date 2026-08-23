/**
 * identity 错误目录(AGENT.md §11 / ADR-0001):业务拒绝经 defineErrorCatalog 自有目录表达,
 * 码带 identity. 命名空间;目录封闭性由 __test__/errors.test.ts 快照锁死。
 * 内部不变量破坏(不可能分支)不经目录,直接抛 @tokenlens/errors 的 DefectError。
 */
import { defineErrorCatalog } from '@tokenlens/errors';

export const identityErrors = defineErrorCatalog('identity', {
  invalid_input: {
    category: 'invalid_input',
    message: 'Invalid identity input',
    zh: '身份参数非法',
  },
  unknown_identifier_kind: {
    category: 'invalid_input',
    message: 'Unknown identifier kind',
    zh: '未知标识类型',
  },
  unknown_provider: {
    category: 'invalid_input',
    message: 'Unknown OAuth provider',
    zh: '未知 OAuth 提供方',
  },
  unknown_challenge_kind: {
    category: 'invalid_input',
    message: 'Unknown challenge kind',
    zh: '未知挑战类型',
  },
  unknown_realm: {
    category: 'invalid_input',
    message: 'Unknown identity realm',
    zh: '未知身份域',
  },
  invalid_identifier: {
    category: 'invalid_input',
    message: 'Malformed identifier',
    zh: '标识格式非法',
  },
  invalid_user_id: {
    category: 'invalid_input',
    message: 'Invalid subject id',
    zh: '主体 id 非法',
  },
  invalid_subject: {
    category: 'invalid_input',
    message: 'Malformed OAuth subject',
    zh: 'OAuth subject 格式非法',
  },
  weak_password: {
    category: 'invalid_input',
    message: 'Password does not meet the policy',
    zh: '密码不满足策略',
  },
  invalid_credentials: {
    category: 'forbidden',
    message: 'Invalid credentials',
    zh: '凭据错误',
  },
  identifier_taken: {
    category: 'conflict',
    message: 'Identifier already bound to another account',
    zh: '标识已被其他账号占用',
  },
  challenge_invalid: {
    category: 'invalid_input',
    message: 'Challenge is invalid, consumed, aborted or expired',
    zh: '挑战不存在、已消费、已作废或已过期',
  },
  code_invalid: {
    category: 'invalid_input',
    message: 'Verification code is incorrect',
    zh: '验证码错误',
  },
  challenge_cooldown: {
    category: 'rate_limited',
    message: 'Challenge cooldown in effect',
    zh: '验证码发送冷却中',
  },
  undeliverable_challenge: {
    category: 'unavailable',
    message: 'Challenge target has no delivery channel',
    zh: '挑战目标无可用投递通道',
  },
  delivery_failed: {
    category: 'unavailable',
    message: 'Challenge delivery failed',
    zh: '验证码投递失败',
  },
  oauth_link_not_found: {
    category: 'not_found',
    message: 'OAuth link not found',
    zh: 'OAuth 绑定不存在',
  },
  provider_already_linked: {
    category: 'conflict',
    message: 'OAuth identity already linked',
    zh: 'OAuth 身份已绑定',
  },
  last_credential: {
    category: 'forbidden',
    message: 'Cannot remove the last credential',
    zh: '不可移除最后一个登录凭据',
  },
  totp_not_enrolled: {
    category: 'forbidden',
    message: 'TOTP is not enrolled or still pending',
    zh: 'TOTP 未注册或仍在挂起中',
  },
  totp_already_enrolled: {
    category: 'conflict',
    message: 'TOTP is already enrolled',
    zh: 'TOTP 已注册',
  },
  invalid_totp_code: {
    category: 'forbidden',
    message: 'Invalid MFA code',
    zh: 'MFA 验证码错误',
  },
  invalid_token: {
    category: 'forbidden',
    message: 'Session token is invalid or expired',
    zh: '会话令牌无效或已过期',
  },
  captcha_invalid: {
    category: 'invalid_input',
    message: 'Captcha verification failed',
    zh: '人机验证未通过',
  },
  captcha_unavailable: {
    category: 'unavailable',
    message: 'Captcha service unavailable',
    zh: '人机验证服务不可用',
  },
  oauth_state_invalid: {
    category: 'invalid_input',
    message: 'OAuth state is invalid, expired or mismatched',
    zh: 'OAuth state 无效、已过期或不匹配',
  },
  oauth_state_unavailable: {
    category: 'unavailable',
    message: 'OAuth state store unavailable',
    zh: 'OAuth state 存储不可用',
  },
  oauth_provider_unconfigured: {
    category: 'not_found',
    message: 'OAuth provider is not configured',
    zh: 'OAuth 提供方未配置',
  },
  oauth_profile_failed: {
    category: 'unavailable',
    message: 'OAuth upstream exchange failed',
    zh: 'OAuth 上游交换失败',
  },
});
