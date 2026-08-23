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
  accounts: WalletAccount[];
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

// ── 钱包流水 (GET /v1/wallet/statement;游标分页,锚=legId) ──────────────────
export interface StatementRow {
  /** 账腿 id(游标锚:下一页 beforeLegId) */
  legId: number;
  /** 腿类型(充值/推理扣费/订阅扣费/佣金…) */
  transactionKind: string;
  refType: string;
  refId: string;
  /** 带符号金额(元,字符串) */
  amount: string;
  balanceAfter: string;
  memo: string | null;
  createdAt: string;
}
/** 流水游标页:满页时 nextCursor=尾腿 legId(字符串形态) */
export interface StatementPage {
  rows: StatementRow[];
  nextCursor?: string;
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
  org: { id: number; name: string } | null;
  members: OrgMemberRow[];
  /** 待接受邀请(仅 owner 可见;token 不回显——链接只在邀请创建时下发一次) */
  invitations?: OrgInvitationSummary[];
}

/** 公开套餐目录行 (GET /v1/plans;用户面只出上架 subscription 档) */

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

// ── 认证步骤(公开面;POST /v1/auth/*) ─────────────────────────────────────
/** 登录/注册页能力探测 (GET /v1/auth/capabilities) */
export interface AuthCapabilities {
  registerEnabled: boolean;
  captchaSiteKey: string | null;
  emailCodeRequired: boolean;
}
/** 登录/注册第一步响应判别联合(kind 缺省按失败处理) */
export interface AuthStepResult {
  kind?: 'code_required' | 'success';
  challengeId?: string;
  token?: string;
  userId?: number;
  email?: string;
  gifted?: boolean;
}
/** POST /v1/auth/login/verify 成功形态(登录两步制第二步) */
export interface LoginVerifyResult {
  token: string;
  userId: number;
}
/** POST /v1/auth/password 成功形态(吊销全部旧会话并当场重签) */
export interface PasswordChangeResult {
  token: string;
}
/** POST /v1/auth/logout */
export interface LogoutResult {
  ok: boolean;
}
/** PATCH /v1/me/display-name */
export interface DisplayNameResult {
  displayName: string;
}

// ── OAuth(公开面) ──────────────────────────────────────────────────────────
/** GET /v1/oauth/providers(已配置登录方式,空数组=纯密码登录) */
export interface OAuthProviders {
  providers: string[];
}

// ── 公开定价 (GET /v1/pricing) ─────────────────────────────────────────────
export interface PricingModel {
  id: number;
  externalName: string;
  contextLength: number | null;
  pricingUnit: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  unitPrice: string;
  isFree: boolean;
  /** 登录态富化(/v1/pricing/personal):费率卡系数与到手价 */
  coefficient?: string;
  effective?: {
    inputPrice: string;
    outputPrice: string;
    cacheInputPrice: string;
    unitPrice: string;
  };
  personalized?: boolean;
  rateCardStatus?: number | null;
}
/** 定价目录页(q/free 过滤在服务端目录内做;envelope 键为 models——v1 形态保留) */
export interface PricingPage {
  models: PricingModel[];
  total: number;
  page: number;
  pageSize: number;
}

// ── 用量聚合信封 ───────────────────────────────────────────────────────────
/** GET /v1/usage/by-model */
export interface UsageByModelPage {
  rows: UsageByModelItem[];
}
/** GET /v1/usage/summary(envelope 键为 list——v1 形态保留) */
export interface UsageSummaryPage {
  list: UsageDayRow[];
}
/** GET /v1/usage/rate(近 60 秒实时速率) */
export interface UsageRate {
  rpm: number;
  tpm: number;
}

// ── 钱包账户摘要 (GET /v1/wallet/accounts) ─────────────────────────────────
export interface WalletAccount {
  id: string;
  kind: string;
  code: string | null;
  currency: string;
  balance: string;
  inFlight: string;
  creditLimit: string;
  status: string;
}
export interface WalletAccountsResult {
  accounts: WalletAccount[];
}

// ── 支付 (POST/GET /v1/payments/*) ─────────────────────────────────────────
/** 充值订单行(status:0 created/1 paid/2 credited/4 expired) */
export interface PaymentOrderRow {
  id: string;
  provider: string;
  providerOrderId: string;
  userId: number;
  amount: string;
  currency: string;
  creditAmount: string;
  status: number;
  createdAt: string;
}
/** 订单列表(信封只 rows 无 total——契约缺口 G3,UI 按「加载更多」消费) */
export interface PaymentOrdersPage {
  rows: PaymentOrderRow[];
}
/** POST /v1/payments/orders 201 */
export interface TopupOrderResult {
  orderId: string;
  payUrl: string;
  creditAmount: string;
}
export interface PaymentChannel {
  id: string;
  label: string;
}
/** GET /v1/payments/channels */
export interface PaymentChannelsResult {
  channels: PaymentChannel[];
}

// ── 兑换码 ─────────────────────────────────────────────────────────────────
/** POST /v1/redeem 成功形态 */
export interface RedeemResult {
  amount: string;
  balanceAfter: string;
  transactionId: number;
}
/** GET /v1/redeem/history(信封只 rows) */
export interface RedeemHistoryPage {
  rows: RedeemHistoryItem[];
}

// ── 邀请返佣 (GET /v1/referrals*) ──────────────────────────────────────────
/** GET /v1/referrals/config(全零=前端隐藏入口) */
export interface ReferralConfig {
  enabled: boolean;
  signupBonus: string;
  commissionRate: string;
}
export interface ReferralInvitee {
  inviteeId: number;
  inviteeName: string | null;
  createdAt: string;
  status: number;
}
/** GET /v1/referrals */
export interface ReferralOverview {
  affCode: string;
  inviteUrl: string;
  signupBonus: string;
  commissionRate: string;
  invited: ReferralInvitee[];
  totalCommission: string;
}

// ── 列表信封(用户面统一 {rows,total,page,limit};例外见各类型注释) ──────────
export interface RowsPage<Row> {
  rows: Row[];
}
export interface RowsTotalPage<Row> extends RowsPage<Row> {
  total: number;
}
