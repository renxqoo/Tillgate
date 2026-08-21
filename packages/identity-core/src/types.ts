/** 身份内核契约类型（对外唯一形状；实现文件只引用此处，不重复定义） */

/** 标识类型词表（DB CHECK 同款）：email / phone / username */
export type IdentifierKind = 'email' | 'phone' | 'username';

/** 归一化前的调用方输入（归一化在包内完成，存储与比较永远用归一形态） */
export interface Identifier {
  kind: IdentifierKind;
  value: string;
}

/** 凭据行视角的已归一标识（= Identifier，独立命名保留语义位） */
export type NormalizedIdentifier = Identifier;

export type DeliveryChannel = 'email' | 'sms';

export interface IdentityAuditEvent {
  actor?: 'user' | 'admin' | 'system';
  action: string;
  targetType: string;
  targetId?: string | number | null;
  detail?: Record<string, unknown> | null;
}

/**
 * 出站效应（提交后触发）：
 *   - deliver：验证码出境的唯一通道。失败会作废挑战并抛 DeliveryFailedError（不吞）——
 *     与 wallet 的 best-effort 不同，验证码发不出去等于流程没发生，必须让调用方知道。
 *   - audit：尽力而为（提交后观测失败不改变安全结果，包内吞掉）。
 */
export interface IdentityEffects {
  deliver?(event: {
    channel: DeliveryChannel;
    to: string;
    kind: string;
    code: string;
    challengeId: string;
  }): Promise<void>;
  audit?(event: IdentityAuditEvent): Promise<void>;
}

export interface PasswordPolicy {
  /** 最小长度（默认 10） */
  minLength: number;
  /** 最大长度（默认 128；防极端输入） */
  maxLength: number;
  /** 业务自定义规则：返回拒绝原因（string）或通过（null） */
  validate?: (password: string) => string | null;
}

/** TOTP 密钥静态加密（生产建议注入；缺省明文存储，风险由消费方自担并写明） */
export interface SecretCipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export interface ChallengeConfig {
  /** 验证码位数（默认 6） */
  digits: number;
  /** 有效期 ms（默认 5 分钟） */
  ttlMs: number;
  /** 同目标同 kind 重发冷却 ms（默认 60 秒；0 = 立即替换旧挑战） */
  cooldownMs: number;
  /** 最大错误次数（默认 5；到次数挑战作废） */
  maxAttempts: number;
}

export interface TotpConfig {
  /** otpauth URL 与展示用的签发方名（默认 'identity'） */
  issuer: string;
  /** 时间步长秒（RFC 6238 默认 30） */
  stepSec: number;
  /** 允许的时钟偏移步数（默认 1 = ±1 步） */
  windowStep: number;
  /** confirm 时生成的恢复码数量（默认 10） */
  recoveryCodeCount: number;
  /** 密钥静态加密（可选） */
  secretCipher?: SecretCipher;
}

/** 三张必填白名单（fail-closed，对齐 wallet）：未声明的标识/Provider/挑战类型一律拒绝 */
export interface CreateIdentityOptions {
  /** 允许的标识类型（如 ['email']；内置词表之外无扩展，扩展=改包发版） */
  identifiers: readonly IdentifierKind[];
  /** 允许的 OAuth provider（如 ['github', 'google']；空数组 = 禁用 OAuth 绑定） */
  providers: readonly string[];
  /** 允许的挑战类型（如 ['email_code', 'password_reset']；业务自定义字符串） */
  challenges: readonly string[];
  /** 允许的会话吊销 realm（默认 ['user']；双身份系统声明 ['user', 'admin']）——fail-closed */
  realms?: readonly string[];
  password?: Partial<Omit<PasswordPolicy, 'validate'>>;
  passwordValidate?: PasswordPolicy['validate'];
  challenge?: Partial<ChallengeConfig>;
  totp?: Partial<Omit<TotpConfig, 'secretCipher'>>;
  totpSecretCipher?: SecretCipher;
  effects?: IdentityEffects;
  clock?: () => Date;
}

// ---------------------------------------------------------------------------
// 动词输入/输出
// ---------------------------------------------------------------------------

/** 事务注入（参与调用方工作流时传入；包内动词自行开事务时忽略） */
export interface TxInput {
  tx?: import('./internal.js').DbLike;
}

export interface RegisterCredentialInput extends TxInput {
  userId: number;
  identifier: Identifier;
  /** 初始密码哈希（本包 hashPassword 产物；明文策略走 resetPassword 动词） */
  passwordHash?: string;
}

export interface RegisterCredentialResult {
  credentialId: number;
  /** true = 标识已属于同一用户，未做任何变更（幂等重放） */
  replayed: boolean;
}

export interface AuthenticateInput {
  identifier: Identifier;
  password: string;
}

export interface ChangePasswordInput {
  userId: number;
  currentPassword: string;
  newPassword: string;
}

export interface ResetPasswordInput {
  userId: number;
  newPassword: string;
}

/** 密码类变更都会推进会话吊销线（改密即全网下线） */
export interface PasswordMutationResult {
  invalidBefore: string;
}

/** 挑战目标二选一：标识（登录前场景，如注册验证/找回）或用户（登录后场景，如登录码） */
export type ChallengeTarget = { identifier: Identifier } | { userId: number };

/** 验码后归还的目标（恰一边非空，与 DB CHECK 同构） */
export interface ResolvedChallengeTarget {
  identifier: NormalizedIdentifier | null;
  userId: number | null;
}

export interface BeginChallengeInput {
  kind: string;
  target: ChallengeTarget;
  /** 随挑战存取的业务载荷（≤4KB，JSON 序列化；验码成功后原样归还） */
  payload?: Record<string, unknown> | null;
  ttlMs?: number;
  cooldownMs?: number;
  maxAttempts?: number;
}

export interface BeginChallengeResult {
  challengeId: string;
  /** 明文验证码（生产经 effects.deliver 出境；返回给调用方以便测试/自定义通道） */
  code: string;
  expiresAt: string;
  channel: DeliveryChannel;
  to: string;
}

export interface VerifyChallengeInput {
  challengeId: string;
  code: string;
}

export interface VerifyChallengeResult {
  target: ResolvedChallengeTarget;
  payload: Record<string, unknown> | null;
}

export interface AbortChallengeInput {
  challengeId: string;
}

export interface AbortChallengeResult {
  aborted: boolean;
}

export interface FindOAuthUserInput {
  provider: string;
  subject: string;
}

export interface LinkOAuthInput extends TxInput {
  userId: number;
  provider: string;
  /** 三方平台用户 id（opaque 字符串） */
  subject: string;
  /** 三方报告的邮箱（仅展示；不参与合并判断） */
  email?: string | null;
}

export interface LinkOAuthResult {
  linkId: number;
  replayed: boolean;
}

export interface UnlinkOAuthInput {
  userId: number;
  provider: string;
}

export interface UnlinkOAuthResult {
  unlinked: boolean;
}

export interface EnrollTotpInput {
  userId: number;
  /** otpauth URL 的账号标签（业务传邮箱/昵称；缺省用 userId） */
  label?: string;
}

export interface EnrollTotpResult {
  /** base32 密钥（明文只在此时给一次） */
  secret: string;
  otpauthUrl: string;
}

export interface ConfirmTotpInput {
  userId: number;
  code: string;
}

export interface ConfirmTotpResult {
  /** 恢复码明文（只此一次；库内只存哈希） */
  recoveryCodes: string[];
}

export interface VerifyMfaInput {
  userId: number;
  code: string;
}

export interface VerifyMfaResult {
  method: 'totp' | 'recovery';
}

export interface DisableTotpInput {
  userId: number;
  /** 已确认的 TOTP 必须携带有效验证码（TOTP 或恢复码）；未确认的挂起注册免码 */
  code?: string;
}

export interface RevokeSessionsInput {
  userId: number;
  /** 身份域（缺省 'user'；必须在 createIdentity 的 realms 白名单内——fail-closed） */
  realm?: string;
  /** 覆盖吊销时刻（测试/管理回填用；缺省 clock()） */
  at?: Date;
}

export interface RevokeSessionsResult {
  invalidBefore: string;
}

export interface SessionValidAtInput {
  userId: number;
  /** 身份域（缺省 'user'；未声明的 realm 读=无锚点=全有效，安全缺省） */
  realm?: string;
  /** 会话签发时刻：Date 或 epoch 毫秒数（JWT iat 秒 × 1000 由调用方换算） */
  iat: Date | number;
}

// ---------------------------------------------------------------------------
// 动词面（一动词一事）
// ---------------------------------------------------------------------------

export interface Identity {
  /** 挂凭据：标识 ↔ 消费方 userId（标识唯一索引兜底并发；同用户重挂=幂等重放） */
  registerCredential(input: RegisterCredentialInput): Promise<RegisterCredentialResult>;
  /** 密码认证：恒定时间 + 统一错误（「用户不存在」与「密码错」不可区分） */
  authenticate(input: AuthenticateInput): Promise<{ userId: number }>;
  /** 改密码：校验原密码 → 换哈希 + 吊销线推进（同一事务） */
  changePassword(input: ChangePasswordInput): Promise<PasswordMutationResult>;
  /** 重置密码（找回/管理员）：免原密码，同样推进吊销线 */
  resetPassword(input: ResetPasswordInput): Promise<PasswordMutationResult>;
  /** 发起挑战：生成验证码 → 存哈希 → 提交后经 effects.deliver 出境（失败即作废） */
  beginChallenge(input: BeginChallengeInput): Promise<BeginChallengeResult>;
  /** 验证挑战：CAS 单次消费（一条 UPDATE 完成计错+消费，无读改写竞态） */
  verifyChallenge(input: VerifyChallengeInput): Promise<VerifyChallengeResult>;
  /** 作废挑战（投递失败/用户重发）；幂等 */
  abortChallenge(input: AbortChallengeInput): Promise<AbortChallengeResult>;
  /** 按 (provider, subject) 找已绑定用户；未绑定返回 null */
  findOAuthUser(input: FindOAuthUserInput): Promise<number | null>;
  /** 绑定三方身份（(provider,subject) 全局唯一=防劫持；同人同 provider 幂等重放） */
  linkOAuth(input: LinkOAuthInput): Promise<LinkOAuthResult>;
  /** 解绑（凭据集守卫：删掉后必须仍留一种登录方式） */
  unlinkOAuth(input: UnlinkOAuthInput): Promise<UnlinkOAuthResult>;
  /** 开始 TOTP 注册（挂起态，confirm 前不生效）；重复挂起=换新密钥 */
  enrollTotp(input: EnrollTotpInput): Promise<EnrollTotpResult>;
  /** 确认 TOTP（首码校验）→ 生效并签发恢复码（明文只此一次） */
  confirmTotp(input: ConfirmTotpInput): Promise<ConfirmTotpResult>;
  /** MFA 校验：TOTP（步进单调防重放）或恢复码（单次消费） */
  verifyMfa(input: VerifyMfaInput): Promise<VerifyMfaResult>;
  /** 关闭 TOTP（已确认必须携有效码；连同恢复码一并删除） */
  disableTotp(input: DisableTotpInput): Promise<{ disabled: boolean }>;
  /** 推进会话吊销线（单调：只前进不后退）→ 早于线的会话全部失效 */
  revokeSessions(input: RevokeSessionsInput): Promise<RevokeSessionsResult>;
  /** 会话签发时刻是否仍有效（无锚点=全有效） */
  sessionValidAt(input: SessionValidAtInput): Promise<boolean>;
}
