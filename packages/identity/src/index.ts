/**
 * @ai-gateway/identity — 会话/JWT/鉴权中间件 + 密码哈希 + 登录限流。
 *
 * 双身份物理隔离：用户面（client-api）与管理面（admin-api）各自独立的
 * cookie / issuer / 密钥 / 校验表，由本包统一提供，避免两个 app 各自实现导致漂移。
 */

// 会话 JWT（双身份：type + issuer 区分）
export {
  signSession,
  verifySession,
  SESSION_DEFAULT_TTL_S,
  type SessionType,
  type SessionPayload,
  type SessionSignInput,
} from './session.js';

// Cookie 容器（双身份）
export {
  SESSION_COOKIE,
  ADMIN_SESSION_COOKIE,
  cookieOptions,
} from './cookies.js';

// 密码哈希（scrypt，users/admins 共用格式）
export {
  hashPassword,
  verifyPassword,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  HASH_LEN,
} from './password.js';

// 登录限流（单源硬锁 + identifier-only 分布式信号，namespace 区分用户/管理员）
export {
  recordLoginFailure,
  resetLoginFailures,
  clientIp,
  LOGIN_FAIL_THRESHOLD,
  LOGIN_FAIL_WINDOW_S,
  LOGIN_LOCK_DURATION_S,
  LOGIN_DISTRIBUTED_SIGNAL_THRESHOLD,
  type ThrottleCheck,
} from './login-throttle.js';

// 登录验证码挑战（client-api 强制邮箱验证 / admin-api 2FA 共用）
export {
  issueLoginCodeChallenge,
  abortLoginCodeChallenge,
  verifyLoginCodeChallenge,
  LOGIN_CODE_TTL_S,
  LOGIN_CODE_MAX_TRIES,
  LOGIN_CODE_RESEND_COOLDOWN_S,
  type LoginCodeNamespace,
  type LoginCodeVerified,
} from './login-code.js';

// 登录验证码发信（SMTP fail-closed；品牌参数化管理后台/用户面板）
export {
  mailerFromEnv,
  createMailer,
  renderLoginCodeEmail,
  ADMIN_MAIL_BRAND,
  USER_MAIL_BRAND,
  type Mailer,
  type MailerConfig,
  type MailBrand,
} from './mailer.js';

// 注册面人机验证（Turnstile；token 浏览器产生、服务端验签，fail-closed）
export {
  createTurnstileCaptcha,
  captchaFromEnv,
  type CaptchaService,
  type TurnstileCaptchaOptions,
} from './captcha.js';

// 领域错误家谱（冷却/验码/人机验证；边界 catch 后翻译，不得裸冒到 HTTP）
export {
  IdentityError,
  LoginCodeCooldownError,
  CodeVerifyError,
  CaptchaError,
  SessionVerifyError,
} from './errors.js';

// Hono Variables 类型
export {
  type ClientEnv,
  type AdminEnv,
  type UserSessionContext,
  type AdminSessionContext,
} from './types.js';

// 中间件
export { userSessionMiddleware } from './middleware/user-session.js';
export { adminAuthMiddleware } from './middleware/admin-session.js';
