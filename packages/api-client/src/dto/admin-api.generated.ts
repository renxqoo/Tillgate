/**
 * admin-api(管理面)wire DTO——GENERATED——禁止手改。
 *
 * 单一事实源:apps/admin-api/src/http/openapi registry → generated/openapi.json
 * (contract → OpenAPI → generated client 生成链;DESIGN §3.4)。重生成:
 *   cd apps/admin-api && bun run generate:openapi && cd ../../packages/api-client && bun run generate:dto
 * 文件为纯声明聚合(单一职责 = 管理面 wire 形状快照)。
 */

// ── me ─────────────────────────────────────

/** 当前登录管理员 (GET /v1/me,admin-api 管理面) */
export interface AdminMeInfo {
  id: number;
  email: string;
  displayName: string | null;
  lastLoginAt: string | null;
  /** 邮箱验证码二次登录已开启 */
  twoFactorEnabled?: boolean;
  /** TOTP 验证器已绑定（接管第二因子） */
  totpEnabled?: boolean;
  /** RBAC 角色（词表单一真相 = control-plane domain/rbac） */
  role: 'super_admin' | 'operator' | 'finance' | 'support' | 'viewer';
  /** 该角色全量权限集（<domain>:<read|write>——前端按此过滤导航） */
  permissions: string[];
}

// ── admins ─────────────────────────────────────

/** 管理员资料行（GET/POST /v1/admins,PATCH /v1/admins/:id） */
export interface AdminRow {
  id: number;
  email: string;
  displayName: string | null;
  /** RBAC 角色（词表/矩阵单一真相 = control-plane domain/rbac） */
  role: 'super_admin' | 'operator' | 'finance' | 'support' | 'viewer';
  /** 0 正常 / 1 封禁 / 2 注销 */
  status: number;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** 创建管理员请求体（POST /v1/admins;字段真相 = contracts zod——角色词表封闭,密码策略单源在 identity） */
export interface AdminCreateBody {
  email: string;
  displayName?: string;
  password: string;
  role: 'super_admin' | 'operator' | 'finance' | 'support' | 'viewer';
}

/** 更新管理员请求体（PATCH /v1/admins/:id;字段真相 = contracts zod——role/status 不可改自身） */
export interface AdminPatchBody {
  displayName?: string | null;
  role?: 'super_admin' | 'operator' | 'finance' | 'support' | 'viewer';
  status?: number;
}

// ── users ─────────────────────────────────────

/** 管理面用户行(GET /v1/users;钱包富化口径 available = balance + creditLimit − inFlight) */
export interface AdminUserRow {
  id: number;
  issuer: string | null;
  subject: string;
  identityProvider: string | null;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  rateCardName: string | null;
  balance: string;
  reservedBalance: string;
  availableBalance: string;
  /** 透支上限(元,>=0)。信用模型:balance 允许降到 -creditLimit。 */
  creditLimit: string;
  /** 每日花费上限(元,NULL=不限)。 */
  dailySpendLimit: string | null;
  status: number;
  isEnterprise: boolean;
  freezeReason: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/** 管理面交易行(GET /v1/users/:id/transactions;多操作管理员字段,终端用户不可见) */
export interface AdminTransactionRow {
  id: number;
  userId: number;
  /** 交易类型(v2 wire:billing statement transactionKind) */
  type: string;
  amount: string;
  balanceAfter: string;
  refType: string | null;
  refId: string | null;
  remark: string | null;
  createdAt: string;
  /** 操作管理员(v2 presenter 恒 null——无来源列) */
  createdBy: number | null;
}

// ── channels ─────────────────────────────────────

/** 管理面渠道行(GET /v1/channels;渠道资金四金额 + 绑定模型清单) */
export interface AdminChannelRow {
  id: number;
  providerId: number;
  name: string;
  baseUrlOverride: string | null;
  /** 模型白名单(DB jsonb 数组;DTO 面沿 v1 快照口径 string | null——数组线上形态在 admin 表单边界转换) */
  models: string | null;
  weight: number;
  priority: number;
  status: number;
  failCount: number;
  /** 记录面逻辑删除时刻(回收站);null = 在册 */
  deletedAt: string | null;
  /** 冷却截止(v2 无列来源,恒 null) */
  cooldownUntil: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 进货总额(元,numeric 字符串) */
  upstreamBudget: string;
  /** 熔断阈值(元,string | null) */
  upstreamThreshold: string | null;
  /** 已消耗上游成本(元,string) */
  upstreamConsumed: string;
  /** 剩余 = 进货 - 已消耗(元,string) */
  upstreamRemaining: string;
  createdAt: string;
  /** 更新时间(v2 无列来源,恒 null) */
  updatedAt: string;
  providerName: string;
  /** 供应商 baseUrl(v2 无列来源,恒 null) */
  providerBaseUrl: string;
  /** 已绑定模型清单(绑定名投影) */
  boundModels: { externalName: string; realModel: string }[];
}

/** 创建渠道请求体（POST /v1/channels;字段真相 = contracts zod——models 线上契约是 string[]） */
export interface ChannelCreateBody {
  providerId: number;
  name: string;
  apiKey: string;
  baseUrlOverride?: string | null;
  models?: string[] | null;
  weight?: number;
  priority?: number;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

/** 更新渠道请求体（PATCH /v1/channels/:id;字段真相 = contracts zod;rpmLimit/tpmLimit null=不限流） */
export interface ChannelUpdateBody {
  providerId?: number;
  name?: string;
  apiKey?: string;
  baseUrlOverride?: string | null;
  models?: string[] | null;
  weight?: number;
  priority?: number;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  status?: number;
  upstreamThreshold?: string | null;
}

/** 渠道连通性探针结果(POST /v1/channels/:id/test;模型探针 /v1/models/:id/test 同形) */
export interface ChannelTestResult {
  ok: boolean;
  durationMs: number;
  /** 后端返回 string 或 { code, message } */
  error?: string | { code?: string; message?: string };
  keyPreview?: string;
}

// ── providers ─────────────────────────────────────

/** 管理面供应商行(GET /v1/providers) */
export interface AdminProviderRow {
  id: number;
  name: string;
  baseUrl: string;
  protocol: string;
  /** 厂商档案引用(VENDOR_PROFILES 词表键;null = 无档案纯透传) */
  vendor: string | null;
  status: number;
  /** 记录面逻辑删除时刻(回收站);null = 在册 */
  deletedAt: string | null;
  createdAt: string;
  /** providers 表当前无 updated_at 列,接口实际不返回该字段(undefined)。前端展示需做空值兜底(回退 createdAt)。 */
  updatedAt?: string;
}

/** 创建供应商请求体（POST /v1/providers;字段真相 = contracts zod;vendor 空 = 纯透传） */
export interface ProviderCreateBody {
  name: string;
  protocol?: string;
  vendor?: string | null;
  baseUrl: string;
  status?: number;
}

// ── models ─────────────────────────────────────

/** 管理面模型映射行(GET /v1/models;channelIds 列表用例回显) */
export interface AdminModelRow {
  id: number;
  externalName: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  /** 计价单位(token/image/second/char/request)——单位计价模型 2026-08-21 管理面通道 */
  pricingUnit?: string;
  /** 单位单价(元/张·秒·字符·次;token 模型 0) */
  unitPrice?: string;
  /** 变体价格配置(分辨率差价):strategy=variant + params.{selector, prices} */
  billingConfig?: { strategy?: string; params?: { unitPrice?: string; selector?: string; prices?: Record<string, string> } } | null;
  isFree: boolean;
  contextLength: number | null;
  /** 兜底模型清单(v2 无来源,恒 null) */
  fallbackModels: string | null;
  /** 参数规则(v2 无来源,恒 null) */
  paramRules: string | null;
  billingPolicy: Record<string, unknown> | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: number;
  /** 记录面逻辑删除时刻(回收站);null = 在册 */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 已绑定的渠道 id(供「绑定渠道」弹窗回显已选) */
  channelIds: number[];
}

/** 创建模型映射请求体（POST /v1/models;字段真相 = contracts zod,价格十进制字符串,unitPrice 收 string | number） */
export interface ModelCreateBody {
  externalName: string;
  realModel: string;
  contextLength?: number | null;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice?: string;
  pricingUnit?: 'token' | 'request' | 'image' | 'second' | 'char';
  unitPrice?: string | number;
  billingConfig?: { strategy: 'flat' | 'variant' | 'schedule'; params?: { unitPrice?: string; selector?: string; prices?: Record<string, string>; windows?: { label?: string; start: string; end: string; inputPrice?: string; outputPrice?: string; cacheInputPrice?: string; cacheWritePrice?: string; unitPrice?: string }[] } } | null;
  isFree?: boolean;
  billingPolicy?: { version: 1; billingMode: 'unified_input_tokens'; maxInputTokens: number; modalities: { image?: { maxItems: number; maxInlineBytes?: number }; audio?: { maxItems: number; maxInlineBytes?: number }; file?: { maxItems: number; maxInlineBytes?: number } } } | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

/** 更新模型映射请求体（PATCH /v1/models/:id;字段真相 = contracts zod——fallbackModels/paramRules 不在更新面） */
export interface ModelUpdateBody {
  externalName?: string;
  realModel?: string;
  contextLength?: number | null;
  status?: number;
  inputPrice?: string;
  outputPrice?: string;
  cacheInputPrice?: string;
  cacheWritePrice?: string;
  pricingUnit?: 'token' | 'request' | 'image' | 'second' | 'char';
  unitPrice?: string | number;
  billingConfig?: { strategy: 'flat' | 'variant' | 'schedule'; params?: { unitPrice?: string; selector?: string; prices?: Record<string, string>; windows?: { label?: string; start: string; end: string; inputPrice?: string; outputPrice?: string; cacheInputPrice?: string; cacheWritePrice?: string; unitPrice?: string }[] } } | null;
  isFree?: boolean;
  billingPolicy?: { version: 1; billingMode: 'unified_input_tokens'; maxInputTokens: number; modalities: { image?: { maxItems: number; maxInlineBytes?: number }; audio?: { maxItems: number; maxInlineBytes?: number }; file?: { maxItems: number; maxInlineBytes?: number } } } | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

// ── keys ─────────────────────────────────────

/** 管理面 API Key 行(GET /v1/admin-keys;keyPreview 脱敏回显) */
export interface AdminKeyRow {
  id: number;
  /** 脱敏预览 ag_****abcd(明文永不回显) */
  keyPreview: string;
  name: string;
  remark: string | null;
  /** 计费来源:NULL=余额;非空=扣该订阅额度。 */
  subscriptionId: number | null;
  userId: number;
  /** 用户邮箱(v2 accounts 行无用户 join,恒 null) */
  userEmail: string | null;
  /** 用户展示名(v2 accounts 行无用户 join,恒 null) */
  userDisplayName: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** Key 级每日花费上限(元,NULL=不限)。 */
  dailySpendLimit: string | null;
  status: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Key 限额与状态补丁请求体（PATCH /v1/admin-keys/:id;字段真相 = contracts zod;null=不限流） */
export interface AdminKeyUpdateBody {
  name?: string;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailySpendLimit?: string | null;
  status?: number;
}

// ── channel-funds ─────────────────────────────────────

/** 渠道资金流水行(GET /v1/channel-funds) */
export interface AdminChannelFundRow {
  id: number;
  channelId: number;
  channelName: string;
  /** recharge(入货)/ adjust(调账) */
  type: 'recharge' | 'adjust';
  /** 有符号金额(元,numeric 字符串) */
  amount: string;
  /** 变动后渠道额度余额快照(元) */
  balanceAfter: string;
  /** 支付订单号 */
  orderNo: string | null;
  /** 支付凭证 key(本地磁盘 / 未来 OSS) */
  voucher: string | null;
  remark: string | null;
  adminId: number | null;
  adminEmail: string | null;
  adminDisplayName: string | null;
  createdAt: string;
}

// ── rate-cards ─────────────────────────────────────

/** 管理面费率卡行(GET /v1/rate-cards) */
export interface AdminRateCardRow {
  id: number;
  name: string;
  description: string | null;
  status: number;
  createdAt: string;
  /** 更新时间(v2 无列来源,恒 null) */
  updatedAt: string | null;
  /** 系数 numeric(6,3):0.001..9.999,回显恒 3 位小数 */
  coefficient: string;
}

/** 创建费率卡请求体（POST /v1/rate-cards;字段真相 = contracts zod,系数 0.001..9.999） */
export interface RateCardCreateBody {
  name: string;
  description?: string;
  coefficient: string;
}

/** 更新费率卡请求体（PATCH /v1/rate-cards/:id;字段真相 = contracts zod;description null=清除） */
export interface RateCardUpdateBody {
  name?: string;
  description?: string | null;
  status?: number;
  coefficient?: string;
}

// ── redeem-batches ─────────────────────────────────────

/** 管理面兑换批次行(GET /v1/redeem-batches) */
export interface AdminBatchRow {
  id: number;
  name: string;
  remark: string | null;
  amount: string;
  total: number;
  usedCount: number;
  /** 创建管理员 id 的字符串投影(v1 wire 形状) */
  createdBy: string;
  createdAt: string;
}

/** 创建兑换批次请求体（POST /v1/redeem-batches;字段真相 = contracts zod,amount 十进制字符串） */
export interface BatchCreateBody {
  name: string;
  remark?: string;
  amount: string;
  count: number;
  expiresAt?: string;
}

/** 批次创建回执(POST /v1/redeem-batches;明文码仅此一次返回) */
export interface BatchCreated {
  batch: { id: number; name: string; amount: string; total: number };
  /** 明文兑换码(仅创建响应返回一次,库内只有哈希) */
  codes: string[];
}

/** 兑换码行(GET /v1/redeem-batches/:id/codes;codeMasked 哈希脱敏) */
export interface RedeemCodeRow {
  id: number;
  /** 哈希脱敏:首 8 + **** + 尾 4 */
  codeMasked: string;
  status: number;
  /** 使用用户 id 的字符串投影;null=未使用 */
  usedBy: string | null;
  usedAt: string | null;
  expiresAt: string | null;
}

// ── stats ─────────────────────────────────────

/** 概览响应(GET /v1/stats/overview;今日为北京日界) */
export interface StatsOverview {
  today: { requests: number; inputTokens: number; outputTokens: number; cost: string; successCount: number; failedCount: number; successRate: number };
  total: { cost: string; requests: number };
  channelHealth: { status: number; count: number }[];
}

/** 分组聚合行(GET /v1/stats/usage;group=user/model/channel) */
export interface StatsUsageItem {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: string;
  upstreamCost: string;
}

/** 按日趋势行(GET /v1/stats/trends;日界为北京时间) */
export interface StatsTrendRow {
  date: string;
  requests: number;
  successCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: string;
}

/** 按日趋势响应(GET /v1/stats/trends) */
export interface StatsTrends {
  /** 回看天数（含今日） */
  days: number;
  rows: StatsTrendRow[];
}

/** 请求日志行(GET /v1/logs;30 天窗内置) */
export interface LogRow {
  id: number;
  requestId: string;
  userId: number;
  /** 用户名(displayName 优先,其次 email;LEFT JOIN users,可能为 null) */
  userName: string | null;
  /** v2 无来源列,恒 null */
  apiKeyId: number | null;
  method: string;
  path: string;
  statusCode: number;
  errorCode: string | null;
  durationMs: number;
  requestSummary: { model: string; stream: boolean; max_tokens: number; messageCount: number } | null;
  /** 重试次数(v1 快照口径;v2 presenter 暂不输出——展示兜底为 1 次) */
  attempts: number;
  /** 来源 IP(X-Forwarded-For 首段 / X-Real-IP / socket,鉴权前记录) */
  sourceIp: string | null;
  createdAt: string;
}

/** 管理端用量明细行(GET /v1/usage-logs;恒 status=0 只看已计费行)——估算扣款一等字段 */
export interface AdminUsageRow {
  id: number;
  requestId: string;
  userId: number;
  userName: string | null;
  credentialType: string;
  externalModel: string;
  realModel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** 单位计价行(>0 时输入/输出 token 无意义,展示单位用量) */
  units?: number;
  unitPrice?: string | null;
  pricingUnit?: string;
  amount: string;
  calculatedAmount: string;
  planAmount: string;
  paygAmount: string;
  billedBy: string;
  upstreamCost: string | null;
  durationMs: number;
  upstreamTtftMs?: number | null;
  clientTtftMs?: number | null;
  stream: boolean;
  streamAborted: boolean;
  /** 估算结算标记(2026-08-17 政策):用户取消/完成缺 usage 按估算扣款 */
  estimated: boolean;
  /** 估算归属(estimated=true 时有值) */
  estimateReason: string | null;
  createdAt: string;
}

/** 审计日志行(GET /v1/audit-logs) */
export interface AuditLogRow {
  id: number;
  adminId: number | null;
  actor: string | null;
  /** 管理员标识(v2 无 join 来源,恒 null) */
  adminSubject: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown> | string | null;
  createdAt: string;
}

// ── options ─────────────────────────────────────

/** 供应商下拉选项(渠道表单用,来源 AdminProviderRow)。 */
export interface ProviderOption {
  id: number;
  name: string;
  baseUrl: string;
  protocol: string;
  status: number;
}

/** 渠道下拉选项(统一形状:models 绑定弹窗展示 providerName,channel-funds 仅用 id/name)。 */
export interface ChannelOption {
  id: number;
  name: string;
  providerName?: string;
}

/** 费率卡下拉选项(用户绑定费率卡用,来源 AdminRateCardRow)。 */
export interface RateCardOption {
  id: number;
  name: string;
  coefficient: string;
}

// ── plans ─────────────────────────────────────

/** plans 表行(amount 均为元 numeric 字符串)。 */
export interface PlanRow {
  id: number;
  name: string;
  kind: 'subscription' | 'pack';
  sortOrder: number | null;
  price: string;
  /** 包月套餐 1~3650;加油包 0 */
  periodDays: number;
  quotaAmount: string;
  allowSeats: boolean;
  status: number;
}

/** 创建套餐请求体（POST /v1/plans;字段真相 = contracts zod——price/quotaAmount 是十进制字符串,kind 不可变） */
export interface PlanCreateBody {
  name: string;
  kind?: 'subscription' | 'pack';
  sortOrder?: number | null;
  price: string;
  periodDays?: number;
  quotaAmount: string;
  allowSeats?: boolean;
}

/** 更新套餐请求体（PATCH /v1/plans/:id;字段真相 = contracts zod——kind 创建后不可变） */
export interface PlanUpdateBody {
  name?: string;
  sortOrder?: number | null;
  price?: string;
  periodDays?: number;
  quotaAmount?: string;
  allowSeats?: boolean;
  status?: number;
}

// ── subscriptions ─────────────────────────────────────

/** admin 订阅列表行。 */
export interface AdminSubscriptionRow {
  id: number;
  userId: number;
  userSubject: string;
  userDisplayName: string | null;
  planId: number;
  planName: string;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
  quantity: number;
  price: string;
  remainingAmount: string;
  status: number;
  createdAt: string;
}

// ── billing-operations ─────────────────────────────────────

/** 死单行(status=dead 专属列表;reservedAmount 仅非 null 时输出)。 */
export interface DeadCaseRow {
  requestId: string;
  userId: number;
  status: string;
  /** 乐观锁修订号(retry/abandon 决策体须回传 expectedRevision) */
  revision: number;
  attempt: number;
  failureCode: string | null;
  lastError: string | null;
  /** 冻结金额(元,numeric 字符串;可缺省) */
  reservedAmount?: string;
  createdAt: string;
}

/** 死单复核决策体（retry/abandon 同形;理由必填;expectedRevision 乐观锁——字段真相 = contracts zod） */
export interface DeadCaseDecisionBody {
  expectedRevision: number;
  reason: string;
  evidenceRefs?: string[];
}

// ── tracing ─────────────────────────────────────

/** trace 摘要行(GET /v1/tracing/recent 列表)。 */
export interface TraceSummaryRow {
  traceId: string;
  rootName: string;
  startTimeMs: number;
  durationMs: number;
  spanCount: number;
  hasError: boolean;
  services: string[];
  requestId: string | null;
}

/** span 落库行的 JSON 形态(时间为 ISO 字符串;attributes 为归一化原始键值)。 */
export interface TraceSpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  /** OTel StatusCode:0=UNSET 1=OK 2=ERROR */
  statusCode: number;
  statusMessage: string | null;
  requestId: string | null;
  userId: number | null;
  channel: string | null;
  model: string | null;
  attributes: Record<string, unknown>;
  events: { name: string; timeMs: number; attributes?: Record<string, unknown> }[];
}

/** trace 详情(GET /v1/tracing/traces/:traceId 与 /by-request/:requestId)。 */
export interface TraceDetailDto {
  spans: TraceSpanRow[];
  services: string[];
  startMs: number;
  durationMs: number;
}

/** 渠道健康聚合(topology 行)。 */
export interface ChannelHealthRow {
  channel: string;
  attempts: number;
  errors: number;
  avgDurationMs: number;
  lastAt: number | null;
  lastError: string | null;
}

/** GET /v1/tracing/topology 响应(hours=回看窗口)。 */
export interface TraceTopologyResponse {
  /** 回看窗口（钳位 1..168） */
  hours: number;
  channels: ChannelHealthRow[];
}

/** GET /v1/tracing/stats 响应。 */
export interface TracingStatsResponse {
  storage: { spans: number; oldestDays: number | null; partitions: string[] };
}
