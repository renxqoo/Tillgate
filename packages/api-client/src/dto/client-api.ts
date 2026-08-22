/**
 * client-api(用户面)wire DTO 手写快照。
 *
 * 过渡态(DESIGN §3.4):OpenAPI 生成链(总纲 P3)落地后本目录整体被 generated/client-api
 * 替换并同提交删除;生成链建立前手写 DTO 是唯一事实源,禁止双轨(总纲 §2.2)。
 * 对齐后端真实字段名,全 camelCase;后端唯一蛇形字段:分页 envelope 的 page_size。
 */

/** 当前登录用户 (GET /v1/me,client-api 用户面) */
export interface MeInfo {
  id: number;
  subject: string;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  rateCardName: string | null;
  status: number;
  isEnterprise: boolean;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: string | null;
  createdAt: string;
  accounts: Array<{
    id: string;
    kind: string;
    code: string | null;
    currency: string;
    balance: string;
    inFlight: string;
    creditLimit: string;
    status: string;
  }>;
}

// ── Key (GET/POST /v1/keys) ────────────────────────────────────────────────
export interface KeyRow {
  id: number;
  keyPreview: string;
  name: string;
  remark: string | null;
  /** 计费来源:NULL=余额;非空=扣该订阅额度(个人/组织订阅)。 */
  subscriptionId: number | null;
  status: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** Key 级每日花费上限(元,NULL=不限)。 */
  dailySpendLimit: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface KeyCreated {
  id: number;
  name: string;
  plaintext: string;
}

// ── App (GET/POST /v1/apps) ────────────────────────────────────────────────
export interface AppRow {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  description: string | null;
  scope: string | null;
  status: number;
  createdAt: string;
  rotatedAt: string | null;
}
export interface AppCreated {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  clientSecret: string;
}

// ── Transactions (GET /v1/me/transactions, /v1/admin/users/:id/transactions) ─
export interface TransactionRow {
  id: number;
  userId: number;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  refType: string | null;
  refId: string | null;
  remark: string | null;
  createdAt: string;
}

/** 我的充值码兑换记录 (GET /v1/redeem/history;不含明文码/哈希) */
export interface RedeemHistoryItem {
  /** 兑换的码 id(一码一兑——历史行唯一键) */
  codeId: number;
  /** 面值(元) */
  amount: string;
  /** 批次名 */
  batchName: string;
  /** 兑换时间 */
  usedAt: string | null;
}

// ── Usage (GET /v1/usage) ──────────────────────────────────────────────────
export interface UsageRow {
  id: number;
  requestId: string;
  userId: number;
  appId: number | null;
  apiKeyId: number | null;
  externalModel: string;
  realModel: string;
  channelId: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  units?: number;
  unitPrice?: string | null;
  pricingUnit?: string | null;
  amount: string;
  /** 计费来源:plan=套餐额度(展示积分)/ payg=余额(展示金额) */
  billedBy: 'plan' | 'payg';
  planAmount: string;
  paygAmount: string;
  upstreamCost: string | null;
  durationMs: number;
  clientTtftMs?: number | null;
  createdAt: string;
  /** 凭证类型:key(API Key)/ jwt(应用) */
  credentialType: string;
  /** 来源 API Key 名称(credentialType=key 时有值) */
  keyName: string | null;
  /** 来源应用名称(credentialType=jwt 时有值) */
  appName: string | null;
}

// ── Usage Summary (GET /v1/usage/summary) ──────────────────────────────────
export interface UsageSummaryItem {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** 金额字符串(numeric 全精度;图表端按需 Number() 展示) */
  cost: string;
}

/** 按日用量行 (GET /v1/usage/summary;日界为北京时间) */
export interface UsageDayRow {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** 金额字符串(numeric 全精度;图表端按需 Number() 展示) */
  cost: string;
}
export interface UsageByModelItem {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** 金额字符串(numeric 全精度;图表端按需 Number() 展示) */
  cost: string;
}

// ── 组织/成员 (GET /v1/orgs) ───────────────────────────────────────────────
export interface OrgRow {
  orgId: number;
  name: string;
  role: 'owner' | 'member';
  /** 组织当前 active 订阅 id(无套餐为 null) */
  subscriptionId: number | null;
  planName: string | null;
  /** 席位(成员名额,无订阅为 null) */
  quantity: number | null;
  quotaAmount: string | null;
  usedAmount: string | null;
  reservedAmount: string | null;
  /** 组织订阅剩余额度(quota−used−reserved,无订阅为 0) */
  remainingAmount: string;
}
export interface OrgMemberRow {
  userId: number;
  role: string;
  status: number;
  dailySpendLimit: string | null;
  monthlyQuota: string | null;
  email: string | null;
  displayName: string | null;
}
export interface OrgInvitationSummary {
  id: number;
  email: string;
  status: number;
  expiresAt: string;
  createdAt: string;
}

export interface OrgDetail {
  org: { id: number; name: string; ownerUserId: number } | null;
  members: OrgMemberRow[];
  /** 待接受邀请(仅 owner 可见;token 不回显——链接只在邀请创建时下发一次) */
  invitations?: OrgInvitationSummary[];
}

/** 订阅「变更」弹窗的目标套餐选项(仅 subscription;用户面订阅 UI 用) */
export interface PlanOption {
  id: number;
  name: string;
  kind: 'subscription' | 'pack';
  sortOrder: number | null;
}

// ── 套餐订阅(包月) ─────────────────────────────────────────────────────────
/** 当前订阅摘要 (client GET /v1/me/subscription) */
export interface CurrentSubscription {
  id: number;
  planId: number;
  planName: string;
  planSortOrder: number | null;
  /** 是否支持席位(团队套餐);false=个人套餐固定 1 席 */
  allowSeats: boolean;
  quantity: number;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
  remainingAmount: string;
  price: string;
  /** 周期天数(30/365) */
  periodDays: number;
  /** 续费总价(元)= 当前档价 × 席位 */
  renewPrice: string;
  /** 当前档单价(元/席) */
  planPrice: string;
  /** 剩余价值(元)= 总价 × (额度-已用-在途)/额度 */
  remainingValue: string;
}

/** 订阅购买/续费/变更结果 */
export interface SubscribeResult {
  userId: number;
  subscriptionId: number;
  planId: number;
  planName: string;
  quantity: number;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  price: string;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}
