/**
 * 集中错误码注册表 —— admin-api / client-api / gateway 静态错误码的单一真相。
 *
 * 每个错误码在此登记：HTTP 状态码 + 双语默认文案。HttpError 构造以 code 为主键，
 * 状态码从注册表推导——调用点不再各自硬编码状态码/文案，新增码必须在此登记
 * （编译期强制：HttpError 的 code 参数是 KnownErrorCode）。
 *
 * message 为英文默认（未携带 Accept-Language 时出口），zh 为中文文案——
 * 错误出口按协商语言取用（errors.ts 的 errorResponseBody），调用点覆盖
 * （HttpError 第二参）不参与翻译，保持调用方原文。
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
  /** 默认可读文案（英文；调用点可用 HttpError 第二参覆盖） */
  message: string;
  /** 中文默认文案（Accept-Language 命中 zh 时出口使用） */
  zh: string;
}

export const ERROR_REGISTRY = {
  // ── 通用 / 边界层兜底 ──
  INTERNAL_ERROR: { status: 500, message: 'Internal server error', zh: '服务器内部错误' },
  INVALID_JSON: { status: 400, message: 'Request body is not valid JSON', zh: '请求体不是有效的 JSON' },
  INVALID_REQUEST: { status: 400, message: 'Invalid request', zh: '无效请求' },
  VALIDATION_ERROR: { status: 400, message: 'Invalid request parameters', zh: '请求参数无效' },
  CONFLICT: { status: 409, message: 'Record already exists (unique constraint conflict)', zh: '记录已存在（唯一约束冲突）' },
  INVALID_REFERENCE: { status: 400, message: 'Referenced resource not found', zh: '引用的资源不存在' },
  CONSTRAINT_VIOLATION: { status: 400, message: 'Operation violates data constraint', zh: '操作违反数据约束' },
  VALUE_TOO_LONG: { status: 400, message: 'Field value exceeds length limit', zh: '字段值超出长度限制' },
  INVALID_VALUE: { status: 400, message: 'Invalid field value format', zh: '字段值格式无效' },
  VALUE_OUT_OF_RANGE: { status: 400, message: 'Field value out of range', zh: '字段值超出范围' },
  INVALID_SORT_FIELD: { status: 400, message: 'Unsupported sort field', zh: '不支持的排序字段' },
  CSRF_ORIGIN_DENIED: { status: 403, message: 'Cross-site request denied', zh: '跨站请求已被拒绝' },
  CSRF_TOKEN_REQUIRED: { status: 403, message: 'Missing or invalid service token', zh: '缺少或无效的服务令牌' },
  INVALID_PARAM: { status: 400, message: 'Invalid path parameter', zh: '路径参数无效' },
  unauthorized: { status: 401, message: 'Session invalid or expired', zh: '会话无效或已过期' },
  REQUEST_TOO_LARGE: { status: 413, message: 'Request body too large', zh: '请求体过大' },
  INVALID_IDEMPOTENCY_KEY: {
    status: 400,
    message: 'idempotency-key must be 1-64 characters of letters, digits, underscores or hyphens',
    zh: 'idempotency-key 必须为 1-64 位的字母、数字、下划线或连字符',
  },

  // ── 认证 / 会话（admin-auth / auth）──
  INVALID_CREDENTIALS: { status: 401, message: 'Incorrect email or password', zh: '邮箱或密码不正确' },
  ACCOUNT_UNAVAILABLE: { status: 403, message: 'Account unavailable', zh: '账号当前不可用' },
  NOT_LOCAL_ACCOUNT: {
    status: 400,
    message: 'This operation is not supported for this account (not a local password account)',
    zh: '当前账号不支持此操作（非本地密码账号）',
  },
  CHALLENGE_INVALID: { status: 400, message: 'Verification challenge is invalid or expired', zh: '验证会话无效或已过期' },
  CODE_INVALID: { status: 401, message: 'Incorrect verification code', zh: '验证码不正确' },
  CODE_SEND_FAILED: { status: 502, message: 'Failed to send verification code email, please try again later', zh: '验证码邮件发送失败，请稍后重试' },
  CODE_RATE_LIMITED: { status: 429, message: 'Verification codes sent too frequently', zh: '验证码发送过于频繁' },
  TOO_MANY_ATTEMPTS: { status: 429, message: 'Too many attempts', zh: '尝试次数过多' },
  RATE_LIMITED: { status: 429, message: 'Too many requests', zh: '请求过于频繁' },
  REGISTER_RATE_LIMITED: { status: 429, message: 'Too many registration requests', zh: '注册请求过于频繁' },
  TWO_FACTOR_UNAVAILABLE: { status: 503, message: 'Two-factor authentication service unavailable', zh: '两步验证服务暂不可用' },
  SMTP_NOT_CONFIGURED: { status: 400, message: 'Email service not configured', zh: '邮件服务未配置' },

  // ── 人机验证（注册面防刷，Turnstile）──
  CAPTCHA_REQUIRED: { status: 400, message: 'Captcha verification required', zh: '需要人机验证' },
  CAPTCHA_INVALID: { status: 400, message: 'Captcha verification failed, please try again', zh: '人机验证未通过，请重试' },
  CAPTCHA_UNAVAILABLE: { status: 503, message: 'Captcha service unavailable, please try again later', zh: '人机验证服务暂不可用，请稍后重试' },
  REGISTER_DISABLED: {
    status: 403,
    message: 'Registration is disabled, please sign in with a third-party provider or log in directly',
    zh: '已关闭注册，请使用第三方登录或直接登录',
  },

  // ── OAuth ──
  OAUTH_NOT_CONFIGURED: { status: 400, message: 'OAuth login is not configured', zh: 'OAuth 登录未配置' },
  OAUTH_INVALID: { status: 400, message: 'Missing authorization parameters', zh: '缺少授权参数' },
  OAUTH_STATE_MISMATCH: { status: 403, message: 'Login session is invalid, please log in again', zh: '登录会话无效，请重新登录' },
  OAUTH_STATE_EXPIRED: { status: 403, message: 'Login state has expired, please log in again', zh: '登录状态已过期，请重新登录' },
  OAUTH_EXCHANGE_FAILED: { status: 502, message: 'Third-party login failed, please retry or use email login instead', zh: '第三方登录失败，请重试或改用邮箱登录' },
  OAUTH_UNKNOWN: { status: 404, message: 'Unknown login method', zh: '未知的登录方式' },

  // ── 用户 / 管理员 ──
  USER_NOT_FOUND: { status: 404, message: 'User not found', zh: '用户不存在' },
  ADMIN_NOT_FOUND: { status: 404, message: 'Admin not found', zh: '管理员不存在' },
  EMAIL_TAKEN: { status: 409, message: 'Email is already registered', zh: '邮箱已注册' },

  // ── 资源不存在（404 族）──
  PLAN_NOT_FOUND: { status: 404, message: 'Plan not found', zh: '套餐不存在' },
  CHANNEL_NOT_FOUND: { status: 404, message: 'Channel not found', zh: '渠道不存在' },
  API_KEY_NOT_FOUND: { status: 404, message: 'API key not found', zh: 'API 密钥不存在' },
  MODEL_NOT_FOUND: { status: 404, message: 'Model not found', zh: '模型不存在' },
  SUBSCRIPTION_NOT_FOUND: { status: 404, message: 'Subscription not found', zh: '订阅不存在' },
  RATE_CARD_NOT_FOUND: { status: 404, message: 'Rate card not found', zh: '费率卡不存在' },
  PROVIDER_NOT_FOUND: { status: 404, message: 'Provider not found', zh: '供应商不存在' },
  ORG_NOT_FOUND: { status: 404, message: 'Organization not found', zh: '组织不存在' },
  ORG_MEMBER_NOT_FOUND: { status: 404, message: 'Member not found', zh: '成员不存在' },
  APP_NOT_FOUND: { status: 404, message: 'App not found', zh: '应用不存在' },
  REDEEM_CODE_NOT_FOUND: { status: 404, message: 'Redeem code not found', zh: '兑换码不存在' },
  REDEEM_INVALID_CODE: { status: 400, message: 'Invalid redeem code', zh: '无效的兑换码' },
  REDEEM_CODE_ALREADY_USED: { status: 409, message: 'Redeem code already used', zh: '兑换码已被使用' },
  REDEEM_CODE_REVOKED: { status: 409, message: 'Redeem code has been revoked', zh: '兑换码已被撤销' },
  REDEEM_CODE_EXPIRED: { status: 400, message: 'Redeem code has expired', zh: '兑换码已过期' },
  REDEEM_BATCH_NOT_FOUND: { status: 404, message: 'Redeem batch not found', zh: '兑换码批次不存在' },
  NO_SUBSCRIPTION: { status: 404, message: 'No active subscription', zh: '没有生效中的订阅' },
  INVITATION_NOT_FOUND: { status: 404, message: 'Invitation not found', zh: '邀请不存在' },
  INVITATION_INVALID: { status: 404, message: 'Invalid invitation', zh: '无效的邀请' },
  CATALOG_SOURCE_NOT_FOUND: { status: 404, message: 'Catalog source not found', zh: '目录来源不存在' },
  VOUCHER_NOT_FOUND: { status: 404, message: 'Voucher not found', zh: '凭证不存在' },

  // ── 状态冲突（409 族）──
  IDEMPOTENCY_CONFLICT: { status: 409, message: 'Idempotency key already used for a different request', zh: '幂等键已用于其他请求' },
  SEATS_FULL: { status: 409, message: 'Organization seats are full', zh: '组织席位已满' },
  ORG_NO_SUBSCRIPTION: { status: 409, message: 'Organization has no active subscription, operation not allowed', zh: '组织没有生效中的订阅，不允许此操作' },
  DOWNGRADE_NOT_ALLOWED: { status: 409, message: 'Downgrade not allowed', zh: '不允许降级' },
  ALREADY_SUBSCRIBED: { status: 409, message: 'Active subscription already exists', zh: '已存在生效中的订阅' },
  /** 订阅在操作窗口内被并发取消/替换（账本行级状态守卫命中 0 行） */
  SUBSCRIPTION_INACTIVE: { status: 409, message: 'Subscription has been cancelled or replaced, operation rejected', zh: '订阅已被取消或替换，操作被拒绝' },
  PLAN_IN_USE: { status: 409, message: 'Plan is still referenced by subscriptions and cannot be deleted', zh: '套餐仍被订阅引用，无法删除' },
  KEY_LIMIT_REACHED: { status: 409, message: 'API key limit reached', zh: '已达 API 密钥数量上限' },
  INVITATIONS_FULL: { status: 409, message: 'Pending invitation limit reached', zh: '待处理邀请数量已达上限' },
  INVITATION_REVOKED: { status: 409, message: 'Invitation has been revoked', zh: '邀请已被撤销' },
  INVITATION_EXPIRED: { status: 409, message: 'Invitation has expired', zh: '邀请已过期' },
  INVITATION_ALREADY_ACCEPTED: { status: 409, message: 'Invitation already accepted', zh: '邀请已被接受' },
  APP_LIMIT_REACHED: { status: 409, message: 'App limit reached', zh: '已达应用数量上限' },

  // ── 权限 / 前置条件（403 族）──
  ENTERPRISE_REQUIRED: { status: 403, message: 'This operation requires an enterprise subscription', zh: '此操作需要企业版订阅' },
  SUBSCRIPTION_FORBIDDEN: { status: 403, message: 'No permission to use this subscription', zh: '无权使用该订阅' },
  ORG_FORBIDDEN: { status: 403, message: 'No permission to access this organization resource', zh: '无权访问该组织资源' },
  INVITATION_EMAIL_MISMATCH: { status: 403, message: 'Invitation email does not match the current account', zh: '邀请邮箱与当前账号不一致' },

  // ── 输入校验 / 业务规则（400 族）──
  INSUFFICIENT_BALANCE: { status: 402, message: 'Insufficient balance', zh: '余额不足' },
  INSUFFICIENT_BUDGET: { status: 400, message: 'Insufficient channel budget', zh: '渠道预算不足' },
  SEATS_NOT_ALLOWED: { status: 400, message: 'This plan does not support seat-based purchase', zh: '该套餐不支持按席位购买' },
  PLAN_DISABLED: { status: 400, message: 'Plan is no longer available', zh: '套餐已下架' },
  PLAN_NOT_PURCHASABLE: { status: 400, message: 'Plan is not purchasable at this time', zh: '套餐当前不可购买' },
  NOT_A_PACK: { status: 400, message: 'This plan is not a top-up pack', zh: '该套餐不是充值包' },
  INVALID_QUANTITY: { status: 400, message: 'Invalid purchase quantity', zh: '购买数量无效' },
  INVALID_PERIOD_DAYS: { status: 400, message: 'Invalid period days', zh: '有效期天数无效' },
  INVALID_AMOUNT: { status: 400, message: 'Invalid amount', zh: '金额无效' },
  RATE_CARD_DISABLED: { status: 400, message: 'Rate card is disabled', zh: '费率卡已停用' },
  ORG_CANNOT_REMOVE_OWNER: { status: 400, message: 'Cannot remove the organization owner', zh: '不能移除组织所有者' },
  INVALID_VOUCHER: { status: 400, message: 'Invalid voucher content', zh: '凭证内容无效' },
  VOUCHER_TOO_LARGE: { status: 400, message: 'Voucher file too large', zh: '凭证文件过大' },
  CATALOG_EMPTY: { status: 400, message: 'Catalog is empty', zh: '目录为空' },
  API_KEY_REQUIRED: { status: 400, message: 'Platform API key required', zh: '需要平台 API 密钥' },
  EXTERNAL_NAME_CONFLICT: { status: 409, message: 'External model name is already taken', zh: '对外模型名已被占用' },
  FREE_MODEL_PRICE_CONFLICT: { status: 400, message: 'Explicitly free models must have all-zero prices', zh: '免费模型的价格必须全部为零' },
  RATE_CARD_IN_USE: { status: 409, message: 'Rate card is still bound to users', zh: '费率卡仍绑定着用户' },

  // ── 计费复核操作（BillingOperationError → HTTP，表驱动映射的落点）──
  BILLING_NOT_FOUND: { status: 404, message: 'Billing record not found', zh: '计费记录不存在' },
  BILLING_STATE_CONFLICT: { status: 409, message: 'Billing state has been changed concurrently', zh: '计费状态已被并发修改' },
  BILLING_IDEMPOTENCY_CONFLICT: { status: 409, message: 'Idempotency key conflict on review operation', zh: '复核操作幂等键冲突' },
  BILLING_INVALID_RECEIPT: { status: 422, message: 'Provider receipt validation failed', zh: '供应商回执校验未通过' },
  BILLING_OPERATION_CONFLICT: { status: 409, message: 'Review operation rejected', zh: '复核操作被拒绝' },

  // ── 网关对外面（gateway，OpenAI 兼容；小写蛇形）──
  invalid_api_key: { status: 401, message: 'Invalid API key', zh: '无效的 API 密钥' },
  invalid_request: { status: 400, message: 'Invalid request', zh: '无效请求' },
  invalid_content_length: { status: 400, message: 'Invalid Content-Length', zh: '无效的 Content-Length' },
  request_too_large: { status: 413, message: 'Request body too large', zh: '请求体过大' },
  cors_origin_denied: { status: 403, message: 'Origin not allowed', zh: '来源不被允许' },
  rate_limit_exceeded: { status: 429, message: 'Too many requests', zh: '请求过于频繁' },
  server_draining: { status: 503, message: 'Server is draining for deployment, please try again later', zh: '服务器正在下线部署，请稍后重试' },

  // ── 网关推理管线（全部对外码一次登记，唯一真相）──
  // 分级纪律：本区只有 internal_error 允许 500；资金拒绝 402；限流 429 + retry-after；
  // 上游 4xx 透传码不在此登记（动态值，经 sanitize 白名单放行）。
  internal_error: { status: 500, message: 'Gateway internal error', zh: '网关内部错误' },
  not_found: { status: 404, message: 'Path not found', zh: '路径不存在' },
  conflict: { status: 409, message: 'Record already exists (unique constraint conflict)', zh: '记录已存在（唯一约束冲突）' },
  invalid_reference: { status: 400, message: 'Referenced resource not found', zh: '引用的资源不存在' },
  constraint_violation: { status: 400, message: 'Operation violates data constraint', zh: '操作违反数据约束' },
  value_too_long: { status: 400, message: 'Field value exceeds length limit', zh: '字段值超出长度限制' },
  invalid_value: { status: 400, message: 'Invalid field value format', zh: '字段值格式无效' },
  value_out_of_range: { status: 400, message: 'Field value out of range', zh: '字段值超出范围' },
  model_not_allowed: { status: 403, message: 'Model is not available for the current API key', zh: '当前 API 密钥无权使用该模型' },
  model_not_found: { status: 404, message: 'Model not found or no longer available', zh: '模型不存在或已下线' },
  no_available_channel: { status: 503, message: 'No available channel for this model', zh: '该模型暂无可用渠道' },
  upstream_error: { status: 502, message: 'Gateway internal error', zh: '网关内部错误' },
  request_cancelled: { status: 408, message: 'Request cancelled', zh: '请求已取消' },
  billing_receipt_unavailable: { status: 503, message: 'Request completed, but the billing receipt could not be persisted', zh: '请求已完成，但计费回执未能保存' },
  free_model_daily_limit_exceeded: { status: 429, message: 'Free model daily request limit reached', zh: '已达免费模型每日请求上限' },
  free_model_counter_unavailable: {
    status: 503,
    message: 'Free model counter service is unavailable, free model requests are paused to prevent abuse',
    zh: '免费模型计数服务不可用，为防滥用已暂停免费模型请求',
  },
  insufficient_balance: { status: 402, message: 'Insufficient available balance', zh: '可用余额不足' },
  account_frozen: { status: 403, message: 'Account is frozen', zh: '账号已被冻结' },
  billing_configuration_error: { status: 503, message: 'Billing configuration error', zh: '计费配置错误' },
  daily_spend_limit_exceeded: { status: 402, message: 'Daily spend limit reached', zh: '已达每日消费上限' },
  member_daily_limit: { status: 402, message: 'Member daily spend limit reached', zh: '已达成员每日消费上限' },
  member_quota_exceeded: { status: 402, message: 'Monthly quota exhausted', zh: '本月配额已用尽' },
  subscription_required: { status: 402, message: 'No active subscription (not subscribed or expired)', zh: '没有生效中的订阅（未订阅或已过期）' },
  subscription_quota_exhausted: { status: 402, message: 'Subscription quota exhausted', zh: '订阅配额已用尽' },
  subscription_forbidden: { status: 402, message: 'The subscription bound to the current API key is not permitted', zh: '当前 API 密钥绑定的订阅无权使用' },
  authorization_conflict: { status: 409, message: 'An authorization record with different content already exists for this request ID', zh: '此请求 ID 已存在内容不同的授权记录' },
  billing_temporarily_unavailable: {
    status: 503,
    message: 'Billing settlement service is busy, new requests are paused to protect fund accuracy',
    zh: '计费结算服务繁忙，为保障资金准确性已暂停新请求',
  },
  reservation_limit_exceeded: { status: 422, message: 'Requested max cost exceeds the per-request limit', zh: '请求的最大成本超出单次请求上限' },
  invalid_quote: { status: 503, message: 'Invalid model billing configuration', zh: '模型计费配置无效' },
  invalid_coefficient: { status: 503, message: 'Invalid model billing configuration', zh: '模型计费配置无效' },
  invalid_multimodal_input: { status: 422, message: 'Invalid multimodal input', zh: '无效的多模态输入' },
  unsupported_multimodal_input: { status: 422, message: 'Unsupported multimodal input type', zh: '不支持的多模态输入类型' },
  billing_quote_unavailable: { status: 422, message: 'No valid multimodal billing policy for this model', zh: '该模型没有有效的多模态计费策略' },
  rate_card_disabled: { status: 403, message: 'The rate card bound to this account is disabled, please contact the administrator', zh: '当前账号绑定的费率卡已停用，请联系管理员' },

  // ── 网关鉴权（auth-service 结果码，2026-08 统一登记）──
  key_revoked: { status: 401, message: 'API key has been revoked', zh: 'API 密钥已被吊销' },
  key_locked: { status: 429, message: 'API key is temporarily locked', zh: 'API 密钥被临时锁定' },
  app_disabled: { status: 401, message: 'App has been disabled', zh: '应用已被停用' },
  user_disabled: { status: 401, message: 'Account has been disabled', zh: '账号已被停用' },
  auth_failure_rate_limited: { status: 429, message: 'Too many authentication failures', zh: '认证失败次数过多' },
  token_expired: { status: 401, message: 'Token has expired', zh: '令牌已过期' },
  invalid_token: { status: 401, message: 'Invalid token', zh: '无效的令牌' },
} as const satisfies Record<string, ErrorSpec>;

export type KnownErrorCode = keyof typeof ERROR_REGISTRY;

/** 注册表查询（未登记的码返回 null——调用方应改用 HttpError 而非手拼） */
export function errorSpec(code: string): ErrorSpec | null {
  return (ERROR_REGISTRY as Record<string, ErrorSpec>)[code] ?? null;
}

/**
 * 按协商语言取注册表文案：zh 取 spec.zh，其余（含 en）取 spec.message。
 * 未登记的码回落入参 fallback（调用方原文）。
 */
export function localizedSpecMessage(code: string, locale: string, fallback: string): string {
  const spec = errorSpec(code);
  if (!spec) return fallback;
  return locale === 'zh' ? spec.zh : spec.message;
}

/**
 * 错误出口文案本地化（onError / 内联 c.json 共用规则）：
 * 仅当出口文案与注册表默认文案逐字一致时按语言替换——保证英文行为零变化；
 * 调用点自定义/动态插值的文案不参与翻译，原样保留。
 * 码查找大小写不敏感（用户/管理面注册键为大写蛇形，wire code 为小写蛇形）。
 */
export function localizeMessage(code: string, locale: string, outgoing: string): string {
  const spec = errorSpec(code) ?? errorSpec(code.toUpperCase());
  if (!spec || outgoing !== spec.message) return outgoing;
  return locale === 'zh' ? spec.zh : spec.message;
}
