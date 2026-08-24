/**
 * 错误信封装配（ADR-0001：业务错误定义归能力包、app face 装配）：
 * composeErrorCatalogs 合成全量目录 + FaceOverride 钉死与 category 默认不同的
 * v1 状态语义（410/502/401 族）。禁止 instanceof 业务类翻译表（v1 E1/E3 病灶）。
 */
import { composeErrorCatalogs, defineErrorCatalog } from '@tillgate/errors';
import { HttpErrors, type FaceOverride } from '@tillgate/http';
import { identityErrors } from '@tillgate/identity';
import { AccountsErrors } from '@tillgate/accounts';
import { BillingErrors } from '@tillgate/billing';

/** app 编排期目录（跨能力流程的协议级拒绝——v1 裸码的命名空间化） */
export const clientErrors = defineErrorCatalog('client', {
  register_disabled: {
    category: 'forbidden',
    message: 'Registration is currently disabled',
    zh: '注册已关闭',
  },
  register_rate_limited: {
    category: 'rate_limited',
    message: 'Too many registration attempts from this network',
    zh: '注册请求过于频繁',
  },
  /** 找回密码链接通道不可用(SMTP 或控制台基地址未配)——fail-closed 503 */
  reset_link_unavailable: {
    category: 'unavailable',
    message: 'Password reset is not configured on this deployment',
    zh: '本部署未配置找回密码功能',
  },
  /** 重置令牌无效/过期/已用——统一口径不区分原因 */
  reset_token_invalid: {
    category: 'invalid_input',
    message: 'This reset link is invalid or has expired',
    zh: '重置链接无效或已过期',
  },
  captcha_required: {
    category: 'invalid_input',
    message: 'Captcha verification is required',
    zh: '需要人机验证',
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
  two_factor_unavailable: {
    category: 'unavailable',
    message: 'Email verification is required but not configured',
    zh: '需要邮箱验证但邮件通道不可用',
  },
  auth_guard_unavailable: {
    category: 'unavailable',
    message: 'Login protection unavailable',
    zh: '登录防护服务不可用',
  },
  rate_counter_unavailable: {
    category: 'unavailable',
    message: 'Rate counter unavailable',
    zh: '限流计数服务不可用',
  },
  login_locked: {
    category: 'rate_limited',
    message: 'Account temporarily locked due to failed attempts',
    zh: '失败次数过多，账户暂时锁定',
  },
  account_unavailable: {
    category: 'forbidden',
    message: 'Account is unavailable',
    zh: '账户不可用',
  },
  oauth_unknown: { category: 'not_found', message: 'Unknown login method', zh: '未知的登录方式' },
  oauth_state_mismatch: {
    category: 'forbidden',
    message: 'Login state mismatch',
    zh: '登录状态不匹配',
  },
  oauth_state_expired: {
    category: 'not_found',
    message: 'Login state expired, please retry',
    zh: '登录状态已过期，请重试',
  },
  oauth_callback_failed: {
    category: 'unavailable',
    message: 'Third-party login failed, please retry',
    zh: '第三方登录失败，请重试',
  },
});

/** 状态钉死表：v1 wire 状态码与 category 默认不同的全部条目（app.test.ts 表驱动锁死） */
export const CLIENT_FACE_OVERRIDES: Readonly<Record<string, FaceOverride>> = {
  // v1 410 Gone 族
  'billing.code_expired': { status: 410 },
  'accounts.invitation_expired': { status: 410 },
  'client.oauth_state_expired': { status: 410 },
  'client.oauth_state_mismatch': { status: 403 },
  // v1 401（category 默认 403 的统一改判）
  'identity.invalid_credentials': { status: 401 },
  // v1 502（上游/渠道坏流）
  'client.oauth_callback_failed': { status: 502 },
  'identity.oauth_profile_failed': { status: 502 },
  'identity.delivery_failed': { status: 502 },
  'billing.payment_channel_unavailable': { status: 502 },
  // v1 422（订阅购买资格族——语义分级保留）
  'billing.plan_disabled': { status: 422 },
  'billing.plan_not_purchasable': { status: 422 },
  'billing.subscription_rule': { status: 422 },
  // v1 404（未配置的登录方式）
  'identity.oauth_provider_unconfigured': { status: 404 },
  // v1 410 语义（identity 单次 state 消费失败统一过期口径，见 DESIGN §4）
  'identity.oauth_state_invalid': { status: 410 },
};

/** 全量目录（errorHandler 消费） */
export function clientErrorCatalog() {
  return composeErrorCatalogs(
    HttpErrors,
    identityErrors,
    AccountsErrors,
    BillingErrors,
    clientErrors,
  );
}
