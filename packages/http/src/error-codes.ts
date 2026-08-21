/**
 * 集中错误码注册表 —— admin-api / client-api / gateway 静态错误码的单一真相。
 *
 * 每个错误码在此登记：HTTP 状态码 + 默认可读文案。HttpError 构造以 code 为主键，
 * 状态码从注册表推导——调用点不再各自硬编码状态码/文案，新增码必须在此登记
 * （编译期强制：HttpError 的 code 参数是 KnownErrorCode）。
 *
 * 命名空间约定：
 *   - 管理面/用户面（admin-api/client-api）：大写蛇形（USER_NOT_FOUND）
 *   - 网关对外面（gateway，OpenAI 兼容）：小写蛇形（rate_limit_exceeded）；
 *     上游动态错误码（packages/ai 分类）不在注册表——它们是透传值而非本系统码
 *
 * 错误语义分级（原则 6）：4xx = 客户端输入/权限/状态冲突；5xx 仅服务端故障。
 */

export interface ErrorSpec {
  /** HTTP 状态码（单一真相：调用点不写状态码） */
  status: number;
  /** 默认可读文案（调用点可用 HttpError 第二参覆盖） */
  message: string;
}

export const ERROR_REGISTRY = {
  // ── 通用 / 边界层兜底 ──
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' },
  INVALID_JSON: { status: 400, message: 'Request body is not valid JSON' },
  INVALID_REQUEST: { status: 400, message: 'Invalid request' },
  VALIDATION_ERROR: { status: 400, message: 'Invalid request parameters' },
  CONFLICT: { status: 409, message: 'Record already exists (unique constraint conflict)' },
  INVALID_REFERENCE: { status: 400, message: 'Referenced resource not found' },
  CONSTRAINT_VIOLATION: { status: 400, message: 'Operation violates data constraint' },
  VALUE_TOO_LONG: { status: 400, message: 'Field value exceeds length limit' },
  INVALID_VALUE: { status: 400, message: 'Invalid field value format' },
  VALUE_OUT_OF_RANGE: { status: 400, message: 'Field value out of range' },
  INVALID_SORT_FIELD: { status: 400, message: 'Unsupported sort field' },
  CSRF_ORIGIN_DENIED: { status: 403, message: 'Cross-site request denied' },
  CSRF_TOKEN_REQUIRED: { status: 403, message: 'Missing or invalid service token' },
  INVALID_PARAM: { status: 400, message: 'Invalid path parameter' },
  REQUEST_TOO_LARGE: { status: 413, message: 'Request body too large' },
  INVALID_IDEMPOTENCY_KEY: {
    status: 400,
    message: 'idempotency-key must be 1-64 characters of letters, digits, underscores or hyphens',
  },

  // ── 认证 / 会话（admin-auth / auth）──
  INVALID_CREDENTIALS: { status: 401, message: 'Incorrect email or password' },
  ACCOUNT_UNAVAILABLE: { status: 403, message: 'Account unavailable' },
  NOT_LOCAL_ACCOUNT: { status: 400, message: 'This operation is not supported for this account (not a local password account)' },
  CHALLENGE_INVALID: { status: 400, message: 'Verification challenge is invalid or expired' },
  CODE_INVALID: { status: 401, message: 'Incorrect verification code' },
  CODE_SEND_FAILED: { status: 502, message: 'Failed to send verification code email, please try again later' },
  CODE_RATE_LIMITED: { status: 429, message: 'Verification codes sent too frequently' },
  TOO_MANY_ATTEMPTS: { status: 429, message: 'Too many attempts' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  REGISTER_RATE_LIMITED: { status: 429, message: 'Too many registration requests' },
  TWO_FACTOR_UNAVAILABLE: { status: 503, message: 'Two-factor authentication service unavailable' },
  SMTP_NOT_CONFIGURED: { status: 400, message: 'Email service not configured' },

  // ── 人机验证（注册面防刷，Turnstile）──
  CAPTCHA_REQUIRED: { status: 400, message: 'Captcha verification required' },
  CAPTCHA_INVALID: { status: 400, message: 'Captcha verification failed, please try again' },
  CAPTCHA_UNAVAILABLE: { status: 503, message: 'Captcha service unavailable, please try again later' },
  REGISTER_DISABLED: { status: 403, message: 'Registration is disabled, please sign in with a third-party provider or log in directly' },

  // ── OAuth ──
  OAUTH_NOT_CONFIGURED: { status: 400, message: 'OAuth login is not configured' },
  OAUTH_INVALID: { status: 400, message: 'Missing authorization parameters' },
  OAUTH_STATE_MISMATCH: { status: 403, message: 'Login session is invalid, please log in again' },
  OAUTH_STATE_EXPIRED: { status: 403, message: 'Login state has expired, please log in again' },
  OAUTH_EXCHANGE_FAILED: { status: 502, message: 'Third-party login failed, please retry or use email login instead' },
  OAUTH_UNKNOWN: { status: 404, message: 'Unknown login method' },

  // ── 用户 / 管理员 ──
  USER_NOT_FOUND: { status: 404, message: 'User not found' },
  ADMIN_NOT_FOUND: { status: 404, message: 'Admin not found' },
  EMAIL_TAKEN: { status: 409, message: 'Email is already registered' },

  // ── 资源不存在（404 族）──
  PLAN_NOT_FOUND: { status: 404, message: 'Plan not found' },
  CHANNEL_NOT_FOUND: { status: 404, message: 'Channel not found' },
  API_KEY_NOT_FOUND: { status: 404, message: 'API key not found' },
  MODEL_NOT_FOUND: { status: 404, message: 'Model not found' },
  SUBSCRIPTION_NOT_FOUND: { status: 404, message: 'Subscription not found' },
  RATE_CARD_NOT_FOUND: { status: 404, message: 'Rate card not found' },
  PROVIDER_NOT_FOUND: { status: 404, message: 'Provider not found' },
  ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
  ORG_MEMBER_NOT_FOUND: { status: 404, message: 'Member not found' },
  APP_NOT_FOUND: { status: 404, message: 'App not found' },
  REDEEM_CODE_NOT_FOUND: { status: 404, message: 'Redeem code not found' },
  REDEEM_INVALID_CODE: { status: 400, message: 'Invalid redeem code' },
  REDEEM_CODE_ALREADY_USED: { status: 409, message: 'Redeem code already used' },
  REDEEM_CODE_REVOKED: { status: 409, message: 'Redeem code has been revoked' },
  REDEEM_CODE_EXPIRED: { status: 400, message: 'Redeem code has expired' },
  REDEEM_BATCH_NOT_FOUND: { status: 404, message: 'Redeem batch not found' },
  NO_SUBSCRIPTION: { status: 404, message: 'No active subscription' },
  INVITATION_NOT_FOUND: { status: 404, message: 'Invitation not found' },
  INVITATION_INVALID: { status: 404, message: 'Invalid invitation' },
  CATALOG_SOURCE_NOT_FOUND: { status: 404, message: 'Catalog source not found' },
  VOUCHER_NOT_FOUND: { status: 404, message: 'Voucher not found' },

  // ── 状态冲突（409 族）──
  IDEMPOTENCY_CONFLICT: { status: 409, message: 'Idempotency key already used for a different request' },
  SEATS_FULL: { status: 409, message: 'Organization seats are full' },
  ORG_NO_SUBSCRIPTION: { status: 409, message: 'Organization has no active subscription, operation not allowed' },
  DOWNGRADE_NOT_ALLOWED: { status: 409, message: 'Downgrade not allowed' },
  ALREADY_SUBSCRIBED: { status: 409, message: 'Active subscription already exists' },
  /** 订阅在操作窗口内被并发取消/替换（账本行级状态守卫命中 0 行） */
  SUBSCRIPTION_INACTIVE: { status: 409, message: 'Subscription has been cancelled or replaced, operation rejected' },
  PLAN_IN_USE: { status: 409, message: 'Plan is still referenced by subscriptions and cannot be deleted' },
  KEY_LIMIT_REACHED: { status: 409, message: 'API key limit reached' },
  INVITATIONS_FULL: { status: 409, message: 'Pending invitation limit reached' },
  INVITATION_REVOKED: { status: 409, message: 'Invitation has been revoked' },
  INVITATION_EXPIRED: { status: 409, message: 'Invitation has expired' },
  INVITATION_ALREADY_ACCEPTED: { status: 409, message: 'Invitation already accepted' },
  APP_LIMIT_REACHED: { status: 409, message: 'App limit reached' },

  // ── 权限 / 前置条件（403 族）──
  ENTERPRISE_REQUIRED: { status: 403, message: 'This operation requires an enterprise subscription' },
  SUBSCRIPTION_FORBIDDEN: { status: 403, message: 'No permission to use this subscription' },
  ORG_FORBIDDEN: { status: 403, message: 'No permission to access this organization resource' },
  INVITATION_EMAIL_MISMATCH: { status: 403, message: 'Invitation email does not match the current account' },

  // ── 输入校验 / 业务规则（400 族）──
  INSUFFICIENT_BALANCE: { status: 402, message: 'Insufficient balance' },
  INSUFFICIENT_BUDGET: { status: 400, message: 'Insufficient channel budget' },
  SEATS_NOT_ALLOWED: { status: 400, message: 'This plan does not support seat-based purchase' },
  PLAN_DISABLED: { status: 400, message: 'Plan is no longer available' },
  PLAN_NOT_PURCHASABLE: { status: 400, message: 'Plan is not purchasable at this time' },
  NOT_A_PACK: { status: 400, message: 'This plan is not a top-up pack' },
  INVALID_QUANTITY: { status: 400, message: 'Invalid purchase quantity' },
  INVALID_PERIOD_DAYS: { status: 400, message: 'Invalid period days' },
  INVALID_AMOUNT: { status: 400, message: 'Invalid amount' },
  RATE_CARD_DISABLED: { status: 400, message: 'Rate card is disabled' },
  ORG_CANNOT_REMOVE_OWNER: { status: 400, message: 'Cannot remove the organization owner' },
  INVALID_VOUCHER: { status: 400, message: 'Invalid voucher content' },
  VOUCHER_TOO_LARGE: { status: 400, message: 'Voucher file too large' },
  CATALOG_EMPTY: { status: 400, message: 'Catalog is empty' },
  API_KEY_REQUIRED: { status: 400, message: 'Platform API key required' },
  EXTERNAL_NAME_CONFLICT: { status: 409, message: 'External model name is already taken' },
  FREE_MODEL_PRICE_CONFLICT: { status: 400, message: 'Explicitly free models must have all-zero prices' },
  RATE_CARD_IN_USE: { status: 409, message: 'Rate card is still bound to users' },

  // ── 计费复核操作（BillingOperationError → HTTP，表驱动映射的落点）──
  BILLING_NOT_FOUND: { status: 404, message: 'Billing record not found' },
  BILLING_STATE_CONFLICT: { status: 409, message: 'Billing state has been changed concurrently' },
  BILLING_IDEMPOTENCY_CONFLICT: { status: 409, message: 'Idempotency key conflict on review operation' },
  BILLING_INVALID_RECEIPT: { status: 422, message: 'Provider receipt validation failed' },
  BILLING_OPERATION_CONFLICT: { status: 409, message: 'Review operation rejected' },

  // ── 网关对外面（gateway，OpenAI 兼容；小写蛇形）──
  invalid_api_key: { status: 401, message: 'Invalid API key' },
  invalid_request: { status: 400, message: 'Invalid request' },
  invalid_content_length: { status: 400, message: 'Invalid Content-Length' },
  request_too_large: { status: 413, message: 'Request body too large' },
  cors_origin_denied: { status: 403, message: 'Origin not allowed' },
  rate_limit_exceeded: { status: 429, message: 'Too many requests' },
  server_draining: { status: 503, message: 'Server is draining for deployment, please try again later' },

  // ── 网关推理管线（全部对外码一次登记，唯一真相）──
  // 分级纪律：本区只有 internal_error 允许 500；资金拒绝 402；限流 429 + retry-after；
  // 上游不可用 502/503；上游 4xx 透传码不在此登记（动态值，经 sanitize 白名单放行）。
  internal_error: { status: 500, message: 'Gateway internal error' },
  not_found: { status: 404, message: 'Path not found' },
  conflict: { status: 409, message: 'Record already exists (unique constraint conflict)' },
  invalid_reference: { status: 400, message: 'Referenced resource not found' },
  constraint_violation: { status: 400, message: 'Operation violates data constraint' },
  value_too_long: { status: 400, message: 'Field value exceeds length limit' },
  invalid_value: { status: 400, message: 'Invalid field value format' },
  value_out_of_range: { status: 400, message: 'Field value out of range' },
  model_not_allowed: { status: 403, message: 'Model is not available for the current API key' },
  model_not_found: { status: 404, message: 'Model not found or no longer available' },
  no_available_channel: { status: 503, message: 'No available channel for this model' },
  upstream_error: { status: 502, message: 'Gateway internal error' },
  request_cancelled: { status: 408, message: 'Request cancelled' },
  billing_receipt_unavailable: { status: 503, message: 'Request completed, but the billing receipt could not be persisted' },
  free_model_daily_limit_exceeded: { status: 429, message: 'Free model daily request limit reached' },
  free_model_counter_unavailable: {
    status: 503,
    message: 'Free model counter service is unavailable, free model requests are paused to prevent abuse',
  },
  insufficient_balance: { status: 402, message: 'Insufficient available balance' },
  account_frozen: { status: 403, message: 'Account is frozen' },
  billing_configuration_error: { status: 503, message: 'Billing configuration error' },
  daily_spend_limit_exceeded: { status: 402, message: 'Daily spend limit reached' },
  member_daily_limit: { status: 402, message: 'Member daily spend limit reached' },
  member_quota_exceeded: { status: 402, message: 'Monthly quota exhausted' },
  subscription_required: { status: 402, message: 'No active subscription (not subscribed or expired)' },
  subscription_quota_exhausted: { status: 402, message: 'Subscription quota exhausted' },
  subscription_forbidden: { status: 402, message: 'The subscription bound to the current API key is not permitted' },
  authorization_conflict: { status: 409, message: 'An authorization record with different content already exists for this request ID' },
  billing_temporarily_unavailable: {
    status: 503,
    message: 'Billing settlement service is busy, new requests are paused to protect fund accuracy',
  },
  reservation_limit_exceeded: { status: 422, message: 'Requested max cost exceeds the per-request limit' },
  invalid_quote: { status: 503, message: 'Invalid model billing configuration' },
  invalid_coefficient: { status: 503, message: 'Invalid model billing configuration' },
  invalid_multimodal_input: { status: 422, message: 'Invalid multimodal input' },
  unsupported_multimodal_input: { status: 422, message: 'Unsupported multimodal input type' },
  billing_quote_unavailable: { status: 422, message: 'No valid multimodal billing policy for this model' },
  rate_card_disabled: { status: 403, message: 'The rate card bound to this account is disabled, please contact the administrator' },

  // ── 网关鉴权（auth-service 结果码，2026-08 统一登记）──
  key_revoked: { status: 401, message: 'API key has been revoked' },
  key_locked: { status: 429, message: 'API key is temporarily locked' },
  app_disabled: { status: 401, message: 'App has been disabled' },
  user_disabled: { status: 401, message: 'Account has been disabled' },
  auth_failure_rate_limited: { status: 429, message: 'Too many authentication failures' },
  token_expired: { status: 401, message: 'Token has expired' },
  invalid_token: { status: 401, message: 'Invalid token' },
} as const satisfies Record<string, ErrorSpec>;

export type KnownErrorCode = keyof typeof ERROR_REGISTRY;

/** 注册表查询（未登记的码返回 null——调用方应改用 HttpError 而非手拼） */
export function errorSpec(code: string): ErrorSpec | null {
  return (ERROR_REGISTRY as Record<string, ErrorSpec>)[code] ?? null;
}
