/**
 * admin-api(管理面)wire DTO 手写快照。
 *
 * 过渡态(DESIGN §3.4):OpenAPI 生成链(总纲 P3)落地后本目录整体被 generated/admin-api
 * 替换并同提交删除;生成链建立前手写 DTO 是唯一事实源,禁止双轨(总纲 §2.2)。
 * 文件为纯声明聚合(单一职责 = 管理面 wire 形状快照,control-plane §5.2 同口径)。
 */
import type { TransactionRow } from './client-api';

/** 当前登录管理员 (GET /v1/me,admin-api 管理面) */
export interface AdminMeInfo {
  id: number;
  email: string;
  displayName: string | null;
  lastLoginAt: string | null;
  /** 邮箱验证码二次登录已开启 */
  twoFactorEnabled?: boolean;
}

// ── Admin: Users (GET /v1/admin/users) ─────────────────────────────────────
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

/** 管理面交易行(GET /v1/admin/users/:id/transactions;多操作管理员字段,终端用户不可见) */
export interface AdminTransactionRow extends TransactionRow {
  createdBy: number | null;
}

// ── Admin: Channels (GET /v1/admin/channels) ───────────────────────────────
export interface AdminChannelRow {
  id: number;
  providerId: number;
  name: string;
  baseUrlOverride: string | null;
  models: string | null;
  weight: number;
  priority: number;
  status: number;
  failCount: number;
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
  updatedAt: string;
  providerName: string;
  providerBaseUrl: string;
  boundModels: Array<{ externalName: string; realModel: string }>;
}
/** 模型白名单线上契约是数组(DB jsonb / GET 响应 / import 同口径);
 * 逗号分隔文本是管理端表单的 UX 形态,转换收口在 admin server action 边界。 */
export interface ChannelCreateBody {
  providerId: number;
  name: string;
  apiKey: string;
  baseUrlOverride?: string;
  models?: string[] | null;
  weight?: number;
  priority?: number;
}
export interface ChannelUpdateBody {
  name?: string;
  apiKey?: string;
  baseUrlOverride?: string;
  models?: string[] | null;
  weight?: number;
  priority?: number;
  status?: number;
  /** null=不限流(继承用户/全局),与后端 channelUpdateSchema 对齐。 */
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  /** 熔断阈值(元,>=0),null=0(耗尽才熔断)。与后端 channelUpdateSchema 对齐。 */
  upstreamThreshold?: string | null;
}
export interface ChannelTestResult {
  ok: boolean;
  durationMs: number;
  /** 后端返回 string 或 { code, message } */
  error?: string | { code?: string; message?: string };
  keyPreview?: string;
}

// ── Admin: Providers (GET /v1/admin/providers) ─────────────────────────────
export interface AdminProviderRow {
  id: number;
  name: string;
  baseUrl: string;
  protocol: string;
  /** 厂商档案引用(VENDOR_PROFILES 词表键;null = 无档案纯透传) */
  vendor: string | null;
  status: number;
  createdAt: string;
  /**
   * providers 表当前无 updated_at 列,接口实际不返回该字段(undefined)。
   * 前端展示需做空值兜底(回退 createdAt)。
   */
  updatedAt?: string;
}
export interface ProviderCreateBody {
  name: string;
  baseUrl: string;
  protocol?: string;
  status?: number;
}

// ── Admin: Models (GET/POST /v1/admin/models) ──────────────────────────────
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
  billingConfig?: {
    strategy?: string;
    params?: { unitPrice?: string; selector?: string; prices?: Record<string, string> };
  } | null;
  isFree: boolean;
  contextLength: number | null;
  fallbackModels: string | null;
  paramRules: string | null;
  billingPolicy: Record<string, unknown> | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: number;
  createdAt: string;
  updatedAt: string;
  /** 已绑定的渠道 id(供「绑定渠道」弹窗回显已选) */
  channelIds: number[];
}
export interface ModelCreateBody {
  externalName: string;
  realModel: string;
  inputPrice: string | number;
  outputPrice: string | number;
  cacheInputPrice?: string | number;
  isFree?: boolean;
  billingPolicy?: Record<string, unknown> | null;
}
export interface ModelUpdateBody {
  externalName?: string;
  realModel?: string;
  inputPrice?: string | number;
  outputPrice?: string | number;
  cacheInputPrice?: string | number;
  isFree?: boolean;
  fallbackModels?: string;
  paramRules?: string;
  billingPolicy?: Record<string, unknown> | null;
  rpmLimit?: number;
  tpmLimit?: number;
  status?: number;
}

// ── Admin: Keys (GET/PATCH /v1/admin/keys) ─────────────────────────────────
export interface AdminKeyRow {
  id: number;
  /** 脱敏预览 ag_****abcd(明文永不回显) */
  keyPreview: string;
  name: string;
  remark: string | null;
  /** 计费来源:NULL=余额;非空=扣该订阅额度。 */
  subscriptionId: number | null;
  userId: number;
  userEmail: string | null;
  userDisplayName: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** Key 级每日花费上限(元,NULL=不限)。 */
  dailySpendLimit: string | null;
  status: number;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface AdminKeyUpdateBody {
  name?: string;
  /** null=不限流(继承用户/全局) */
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  /** Key 级每日花费上限(元,NULL=不限)。 */
  dailySpendLimit?: string | null;
  status?: number;
}

// ── Admin: Channel Funds (GET/POST /v1/admin/channel-funds) ────────────────
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

// ── Admin: Rate Cards (GET/POST /v1/admin/rate-cards) ──────────────────────
export interface AdminRateCardRow {
  id: number;
  name: string;
  description: string | null;
  status: number;
  createdAt: string;
  updatedAt: string;
  coefficient: string;
}
export interface RateCardCreateBody {
  name: string;
  description?: string;
  coefficient: string;
}
export interface RateCardUpdateBody {
  name?: string;
  description?: string;
  status?: number;
  coefficient?: string;
}

// ── Admin: Redeem Batches (GET/POST /v1/admin/redeem-batches) ──────────────
export interface AdminBatchRow {
  id: number;
  name: string;
  remark: string | null;
  amount: string;
  total: number;
  usedCount: number;
  createdBy: string;
  createdAt: string;
}
export interface BatchCreateBody {
  name: string;
  remark?: string;
  amount: string;
  count: number;
  expiresAt?: string;
}
export interface BatchCreated {
  batch: { id: number; name: string; amount: string; total: number };
  codes: string[];
}
export interface RedeemCodeRow {
  id: number;
  codeMasked: string;
  status: number;
  usedBy: string | null;
  usedAt: string | null;
  expiresAt: string | null;
}

// ── Admin: Stats (GET /v1/admin/stats/*) ───────────────────────────────────
export interface StatsOverview {
  today: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: string;
    successCount: number;
    failedCount: number;
    successRate: number;
  };
  total: { cost: string; requests: number };
  channelHealth: Array<{ status: number; count: number }>;
}
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
export interface StatsTrends {
  days: number;
  rows: StatsTrendRow[];
}
export interface LogRow {
  id: number;
  requestId: string;
  userId: number;
  /** 用户名(displayName 优先,其次 email;LEFT JOIN users,可能为 null) */
  userName: string | null;
  apiKeyId: number | null;
  method: string;
  path: string;
  statusCode: number;
  errorCode: string | null;
  durationMs: number;
  requestSummary: {
    model: string;
    stream: boolean;
    max_tokens: number;
    messageCount: number;
  } | null;
  attempts: number;
  /** 来源 IP(X-Forwarded-For 首段 / X-Real-IP / socket,鉴权前记录) */
  sourceIp: string | null;
  createdAt: string;
}
/** 管理端用量明细行(GET /v1/admin/usage-logs)——估算扣款一等字段 */
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
  pricingUnit?: string | null;
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

export interface AuditLogRow {
  id: number;
  adminId: number | null;
  actor: string | null;
  adminSubject: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown> | string | null;
  createdAt: string;
}

// ── 下拉选项(页面从列表行投影的 client-safe 选项,单一真相)──────────────
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

// ── 套餐管理(包月;plans 由管理面维护) ──────────────────────────────────────
/** plans 表行(amount 均为元 numeric 字符串)。 */
export interface PlanRow {
  id: number;
  name: string;
  kind: 'subscription' | 'pack';
  sortOrder: number | null;
  price: string;
  periodDays: number;
  quotaAmount: string;
  allowSeats: boolean;
  status: number;
}
export interface PlanCreateBody {
  name: string;
  kind?: 'subscription' | 'pack';
  sortOrder?: number | null;
  price: number;
  /** 包月套餐必填 1~3650;加油包传 0 或省略 */
  periodDays?: number;
  quotaAmount: number;
  allowSeats?: boolean;
}
export interface PlanUpdateBody {
  name?: string;
  /** kind 创建后不可变,更新接口不接受 */
  sortOrder?: number | null;
  price?: number;
  periodDays?: number;
  quotaAmount?: number;
  allowSeats?: boolean;
  status?: number;
}

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
