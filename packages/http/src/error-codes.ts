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
  INTERNAL_ERROR: { status: 500, message: '内部错误' },
  INVALID_JSON: { status: 400, message: '请求体不是合法 JSON' },
  INVALID_REQUEST: { status: 400, message: '请求不合法' },
  VALIDATION_ERROR: { status: 400, message: '参数校验失败' },
  CONFLICT: { status: 409, message: '记录已存在（唯一约束冲突）' },
  INVALID_REFERENCE: { status: 400, message: '引用的资源不存在' },
  CONSTRAINT_VIOLATION: { status: 400, message: '操作违反数据约束' },
  VALUE_TOO_LONG: { status: 400, message: '字段值超出长度限制' },
  INVALID_VALUE: { status: 400, message: '字段值格式非法' },
  VALUE_OUT_OF_RANGE: { status: 400, message: '字段值超出数值范围' },
  INVALID_SORT_FIELD: { status: 400, message: '不支持的排序字段' },
  CSRF_ORIGIN_DENIED: { status: 403, message: '跨站请求被拒绝' },
  CSRF_TOKEN_REQUIRED: { status: 403, message: '缺少或错误的服务间令牌' },
  INVALID_PARAM: { status: 400, message: '路径参数不合法' },
  REQUEST_TOO_LARGE: { status: 413, message: '请求体过大' },
  INVALID_IDEMPOTENCY_KEY: {
    status: 400,
    message: 'idempotency-key 只允许 1-64 位字母/数字/下划线/中划线',
  },

  // ── 认证 / 会话（admin-auth / auth）──
  INVALID_CREDENTIALS: { status: 401, message: '邮箱或密码错误' },
  ACCOUNT_UNAVAILABLE: { status: 403, message: '账号不可用' },
  NOT_LOCAL_ACCOUNT: { status: 400, message: '该账号不支持此操作（非本地密码账号）' },
  CHALLENGE_INVALID: { status: 400, message: '验证码挑战无效或已过期' },
  CODE_INVALID: { status: 401, message: '验证码错误' },
  CODE_SEND_FAILED: { status: 502, message: '验证码邮件发送失败，请稍后重试' },
  CODE_RATE_LIMITED: { status: 429, message: '验证码发送过于频繁' },
  TOO_MANY_ATTEMPTS: { status: 429, message: '尝试次数过多' },
  RATE_LIMITED: { status: 429, message: '请求过于频繁' },
  REGISTER_RATE_LIMITED: { status: 429, message: '注册请求过于频繁' },
  TWO_FACTOR_UNAVAILABLE: { status: 503, message: '两步验证服务不可用' },
  SMTP_NOT_CONFIGURED: { status: 400, message: '邮件服务未配置' },

  // ── 人机验证（注册面防刷，Turnstile）──
  CAPTCHA_REQUIRED: { status: 400, message: '需要人机验证' },
  CAPTCHA_INVALID: { status: 400, message: '人机验证未通过，请重试' },
  CAPTCHA_UNAVAILABLE: { status: 503, message: '人机验证服务不可用，请稍后重试' },
  REGISTER_DISABLED: { status: 403, message: '注册已关闭，请使用第三方登录或直接登录' },

  // ── OAuth ──
  OAUTH_NOT_CONFIGURED: { status: 400, message: 'OAuth 登录未配置' },
  OAUTH_INVALID: { status: 400, message: '缺少授权参数' },
  OAUTH_STATE_MISMATCH: { status: 403, message: '登录会话已失效，请重新登录' },
  OAUTH_STATE_EXPIRED: { status: 403, message: '登录状态已过期，请重新登录' },
  OAUTH_EXCHANGE_FAILED: { status: 502, message: '第三方登录失败，请重试或改用邮箱登录' },
  OAUTH_UNKNOWN: { status: 404, message: '未知登录方式' },

  // ── 用户 / 管理员 ──
  USER_NOT_FOUND: { status: 404, message: '用户不存在' },
  ADMIN_NOT_FOUND: { status: 404, message: '管理员不存在' },
  EMAIL_TAKEN: { status: 409, message: '邮箱已被注册' },

  // ── 资源不存在（404 族）──
  PLAN_NOT_FOUND: { status: 404, message: '套餐不存在' },
  CHANNEL_NOT_FOUND: { status: 404, message: '渠道不存在' },
  API_KEY_NOT_FOUND: { status: 404, message: 'API Key 不存在' },
  MODEL_NOT_FOUND: { status: 404, message: '模型不存在' },
  SUBSCRIPTION_NOT_FOUND: { status: 404, message: '订阅不存在' },
  RATE_CARD_NOT_FOUND: { status: 404, message: '费率卡不存在' },
  PROVIDER_NOT_FOUND: { status: 404, message: '供应商不存在' },
  ORG_NOT_FOUND: { status: 404, message: '组织不存在' },
  ORG_MEMBER_NOT_FOUND: { status: 404, message: '成员不存在' },
  APP_NOT_FOUND: { status: 404, message: '应用不存在' },
  REDEEM_CODE_NOT_FOUND: { status: 404, message: '兑换码不存在' },
  REDEEM_INVALID_CODE: { status: 400, message: '兑换码无效' },
  REDEEM_CODE_ALREADY_USED: { status: 409, message: '兑换码已被使用' },
  REDEEM_CODE_REVOKED: { status: 409, message: '兑换码已被撤销' },
  REDEEM_CODE_EXPIRED: { status: 400, message: '兑换码已过期' },
  REDEEM_BATCH_NOT_FOUND: { status: 404, message: '兑换批次不存在' },
  NO_SUBSCRIPTION: { status: 404, message: '当前没有有效订阅' },
  INVITATION_NOT_FOUND: { status: 404, message: '邀请不存在' },
  INVITATION_INVALID: { status: 404, message: '邀请无效' },
  CATALOG_SOURCE_NOT_FOUND: { status: 404, message: '目录源不存在' },
  VOUCHER_NOT_FOUND: { status: 404, message: '凭证不存在' },

  // ── 状态冲突（409 族）──
  IDEMPOTENCY_CONFLICT: { status: 409, message: '幂等键已用于不同请求' },
  SEATS_FULL: { status: 409, message: '组织席位已满' },
  ORG_NO_SUBSCRIPTION: { status: 409, message: '组织无有效订阅，无法执行该操作' },
  DOWNGRADE_NOT_ALLOWED: { status: 409, message: '不支持降级变更' },
  ALREADY_SUBSCRIBED: { status: 409, message: '已有生效订阅' },
  /** 订阅在操作窗口内被并发取消/替换（账本行级状态守卫命中 0 行） */
  SUBSCRIPTION_INACTIVE: { status: 409, message: '订阅已被取消或替换，操作被拒绝' },
  PLAN_IN_USE: { status: 409, message: '套餐仍被订阅引用，无法删除' },
  KEY_LIMIT_REACHED: { status: 409, message: 'API Key 数量已达上限' },
  INVITATIONS_FULL: { status: 409, message: '待处理邀请数已达上限' },
  INVITATION_REVOKED: { status: 409, message: '邀请已被撤销' },
  INVITATION_EXPIRED: { status: 409, message: '邀请已过期' },
  INVITATION_ALREADY_ACCEPTED: { status: 409, message: '邀请已被接受' },
  APP_LIMIT_REACHED: { status: 409, message: '应用数量已达上限' },

  // ── 权限 / 前置条件（403 族）──
  ENTERPRISE_REQUIRED: { status: 403, message: '该操作需要企业版订阅' },
  SUBSCRIPTION_FORBIDDEN: { status: 403, message: '无权使用该订阅' },
  ORG_FORBIDDEN: { status: 403, message: '无权操作该组织资源' },
  INVITATION_EMAIL_MISMATCH: { status: 403, message: '邀请邮箱与当前账号不匹配' },

  // ── 输入校验 / 业务规则（400 族）──
  INSUFFICIENT_BALANCE: { status: 402, message: '余额不足' },
  INSUFFICIENT_BUDGET: { status: 400, message: '渠道进货额度不足' },
  SEATS_NOT_ALLOWED: { status: 400, message: '该套餐不支持按席位购买' },
  PLAN_DISABLED: { status: 400, message: '套餐已下架' },
  PLAN_NOT_PURCHASABLE: { status: 400, message: '套餐当前不可购买' },
  NOT_A_PACK: { status: 400, message: '该套餐不是加油包' },
  INVALID_QUANTITY: { status: 400, message: '购买数量不合法' },
  INVALID_PERIOD_DAYS: { status: 400, message: '周期天数不合法' },
  INVALID_AMOUNT: { status: 400, message: '金额不合法' },
  RATE_CARD_DISABLED: { status: 400, message: '费率卡已停用' },
  ORG_CANNOT_REMOVE_OWNER: { status: 400, message: '不能移除组织所有者' },
  INVALID_VOUCHER: { status: 400, message: '凭证内容不合法' },
  VOUCHER_TOO_LARGE: { status: 400, message: '凭证文件过大' },
  CATALOG_EMPTY: { status: 400, message: '目录内容为空' },
  API_KEY_REQUIRED: { status: 400, message: '需要平台 API Key' },
  EXTERNAL_NAME_CONFLICT: { status: 409, message: '对外模型名已被占用' },
  FREE_MODEL_PRICE_CONFLICT: { status: 400, message: '显式免费模型必须全零价' },
  RATE_CARD_IN_USE: { status: 409, message: '费率卡仍有用户绑定' },

  // ── 计费复核操作（BillingOperationError → HTTP，表驱动映射的落点）──
  BILLING_NOT_FOUND: { status: 404, message: '账单不存在' },
  BILLING_STATE_CONFLICT: { status: 409, message: '账单状态已被并发变更' },
  BILLING_IDEMPOTENCY_CONFLICT: { status: 409, message: '复核操作幂等键冲突' },
  BILLING_INVALID_RECEIPT: { status: 422, message: '供应商回执校验失败' },
  BILLING_OPERATION_CONFLICT: { status: 409, message: '复核操作被拒绝' },

  // ── 网关对外面（gateway，OpenAI 兼容；小写蛇形）──
  invalid_api_key: { status: 401, message: '无效的 API Key' },
  invalid_request: { status: 400, message: '请求不合法' },
  invalid_content_length: { status: 400, message: 'Content-Length 不合法' },
  request_too_large: { status: 413, message: '请求体过大' },
  cors_origin_denied: { status: 403, message: '来源不被允许' },
  rate_limit_exceeded: { status: 429, message: '请求过于频繁' },
  server_draining: { status: 503, message: '服务正在发布维护，请稍后重试' },
} as const satisfies Record<string, ErrorSpec>;

export type KnownErrorCode = keyof typeof ERROR_REGISTRY;

/** 注册表查询（未登记的码返回 null——调用方应改用 HttpError 而非手拼） */
export function errorSpec(code: string): ErrorSpec | null {
  return (ERROR_REGISTRY as Record<string, ErrorSpec>)[code] ?? null;
}
