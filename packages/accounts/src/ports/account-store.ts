/**
 * AccountStorePort:账号事实持久化端口(DESIGN §6)。
 *
 * 契约要点:
 * - 行投影**结构性排除秘密**(无 passwordHash/keyHash/clientSecretHash);
 * - 全部写方法的时间语义(createdAt/updatedAt/revokedAt/rotatedAt/expiresAt/过期判定)
 *   由实现方用存储时钟表达(DESIGN §5;postgres=clock_timestamp(),替身=注入时钟);
 * - 状态翻转一律 CAS,0 行以 null/false/判别结果表达;
 * - 冲突可能的方法返回判别结果(port 返回事实,错误翻译归 application);
 * - `db` 首参参与调用方事务(§5.4 事务参与 port);席位/订阅守卫对 user_subscriptions
 *   只取最小投影 {id, quantity} 并与 billing 侧同锁互斥(G8)。
 */
import type { DbLike } from '@tokenlens/db';
import type { AppScope } from '../domain/app.js';
import type { MarketingSettings, MarketingSettingsPatch } from '../domain/marketing.js';

// ---- 行投影 ----

export interface UserRecord {
  readonly id: number;
  readonly issuer: string;
  readonly subject: string;
  readonly identityProvider: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly rateCardId: number | null;
  readonly dailySpendLimit: string | null;
  readonly status: number;
  readonly sessionInvalidBefore: Date | null;
  readonly isEnterprise: boolean;
  readonly freezeReason: string | null;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserProfile extends UserRecord {
  readonly rateCardName: string | null;
}

export interface ApiKeyRecord {
  readonly id: number;
  readonly keyPreview: string;
  readonly userId: number;
  readonly appId: number | null;
  readonly subscriptionId: number | null;
  readonly name: string;
  readonly remark: string | null;
  readonly expiresAt: Date | null;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly dailySpendLimit: string | null;
  readonly allowPaygFallback: boolean;
  readonly status: number;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/** 网关鉴权投影:一次查询取回鉴权与限额全集(含属主状态守卫与过期判定,v1 语义) */
export interface ActiveKeyRecord {
  readonly keyId: number;
  readonly userId: number;
  readonly subscriptionId: number | null;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly dailySpendLimit: string | null;
  readonly allowPaygFallback: boolean;
  readonly userRpmLimit: number | null;
  readonly userTpmLimit: number | null;
}

export interface AppRecord {
  readonly id: number;
  readonly appId: string;
  readonly userId: number;
  readonly clientId: string;
  readonly name: string;
  readonly description: string | null;
  readonly subscriptionId: number | null;
  readonly scope: AppScope | null;
  readonly status: number;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
}

/** App JWT 校验投影(resolveAppByAppId;属主状态守卫已含) */
export interface ActiveAppRecord {
  readonly id: number;
  readonly appId: string;
  readonly userId: number;
  readonly scope: AppScope | null;
  readonly subscriptionId: number | null;
}

export interface OrgRecord {
  readonly id: number;
  readonly name: string;
  readonly ownerUserId: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MembershipRecord {
  readonly id: number;
  readonly orgId: number;
  readonly userId: number;
  readonly role: string;
  readonly status: number;
  readonly dailySpendLimit: string | null;
  readonly monthlyQuota: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrgMembershipView extends MembershipRecord {
  readonly orgName: string;
}

export interface MemberView {
  readonly userId: number;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly subject: string;
  readonly role: string;
  readonly status: number;
  readonly dailySpendLimit: string | null;
  readonly monthlyQuota: string | null;
  readonly joinedAt: Date;
}

export interface InvitationRecord {
  readonly id: number;
  readonly orgId: number;
  readonly email: string;
  readonly invitedByUserId: number | null;
  readonly status: number;
  readonly expiresAt: Date;
  readonly acceptedByUserId: number | null;
  readonly createdAt: Date;
}

/** 仅创建路径携带 token(创建响应一次下发;列表/详情投影永不包含) */
export interface InvitationWithToken extends InvitationRecord {
  readonly token: string;
}

/** token 定位快照:过期为读时判定(存储时钟;status=3 不写入,B8 惰性过期) */
export interface InvitationSnapshot extends InvitationWithToken {
  readonly expired: boolean;
}

export interface InviteeView {
  readonly inviteeUserId: number;
  readonly inviteeEmail: string | null;
  readonly inviteeDisplayName: string | null;
  readonly status: number;
  readonly createdAt: Date;
}

export interface RelationView {
  readonly id: number;
  readonly inviterUserId: number;
  readonly inviterEmail: string | null;
  readonly inviterDisplayName: string | null;
  readonly inviteeUserId: number;
  readonly inviteeEmail: string | null;
  readonly inviteeDisplayName: string | null;
  readonly status: number;
  readonly createdAt: Date;
}

/** 管理面读形状:三参数 + 操作人(v1 GET /marketing/settings 断言含 updatedBy) */
export interface MarketingSettingsRecord extends MarketingSettings {
  readonly updatedBy: number | null;
  readonly updatedAt: Date;
}

// ---- 查询形状 ----

export interface ListQuery {
  readonly page: number;
  readonly limit: number;
}

export interface PageResult<T> {
  readonly rows: readonly T[];
  readonly total: number;
}

/** 排序字段已由 application 白名单校验;desc(id) 稳定 tiebreaker 是实现契约 */
export interface SortSpec {
  readonly field: string;
  readonly order: 'asc' | 'desc';
}

// ---- 用户写侧 ----

export interface LocalUserInsert {
  readonly email: string;
  readonly displayName: string;
}

export interface OAuthUserInsert {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string;
}

export interface UserPatch {
  readonly displayName?: string;
  readonly email?: string;
  readonly rateCardId?: number | null;
  readonly status?: number;
  readonly freezeReason?: string | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
  readonly dailySpendLimit?: string | null;
  readonly isEnterprise?: boolean;
}

export type RateCardProbe =
  | { readonly status: 'ok' }
  | { readonly status: 'missing' }
  | { readonly status: 'disabled' };

// ---- Key/App 写侧 ----

export interface ApiKeyInsert {
  readonly keyHash: string;
  readonly keyPreview: string;
  readonly userId: number;
  readonly subscriptionId: number | null;
  readonly name: string;
  readonly remark: string | null;
  readonly expiresAt: Date | null;
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  readonly dailySpendLimit: string | null;
  readonly allowPaygFallback: boolean;
}

export interface ApiKeyPatch {
  readonly name?: string;
  readonly remark?: string | null;
  readonly rpmLimit?: number | null;
  readonly tpmLimit?: number | null;
  readonly dailySpendLimit?: string | null;
  readonly expiresAt?: Date | null;
}

export interface AdminApiKeyPatch extends ApiKeyPatch {
  readonly status?: number;
}

export interface AppInsert {
  readonly appId: string;
  readonly userId: number;
  readonly clientId: string;
  readonly clientSecretHash: string;
  readonly name: string;
  readonly description: string | null;
  readonly subscriptionId: number | null;
  readonly scope: AppScope | null;
}

// ---- 组织写侧 ----

export interface InvitationInsert {
  readonly orgId: number;
  readonly email: string;
  readonly token: string;
  readonly invitedByUserId: number;
  readonly ttlMs: number;
}

export interface MemberLimitsPatch {
  readonly dailySpendLimit?: string | null;
  readonly monthlyQuota?: string | null;
}

/**
 * 账号事实存储端口。方法按聚合分组;实现:adapters/postgres(生产)、
 * testing/in-memory-account-store(行为等价替身,语义与 postgres 同拍演进)。
 */
export interface AccountStorePort {
  // ---- 用户 ----
  insertLocalUser(
    db: DbLike,
    input: LocalUserInsert,
  ): Promise<{ status: 'created'; user: UserRecord } | { status: 'email_taken' }>;
  insertOAuthUser(
    db: DbLike,
    input: OAuthUserInsert,
  ): Promise<{ status: 'created'; user: UserRecord } | { status: 'exists' }>;
  findUserByEmail(db: DbLike, email: string): Promise<UserRecord | null>;
  findUserById(db: DbLike, userId: number): Promise<UserRecord | null>;
  findOAuthUser(db: DbLike, issuer: string, subject: string): Promise<UserRecord | null>;
  getUserProfile(db: DbLike, userId: number): Promise<UserProfile | null>;
  updateUser(
    db: DbLike,
    input: { userId: number; patch: UserPatch; advanceSessionAnchor: boolean },
  ): Promise<UserRecord | null>;
  userExists(db: DbLike, userId: number): Promise<boolean>;
  userIsEnterprise(db: DbLike, userId: number): Promise<boolean>;
  userRateCardBinding(db: DbLike, userId: number): Promise<number | null>;
  rateCardUsable(db: DbLike, rateCardId: number): Promise<RateCardProbe>;
  listUsers(
    db: DbLike,
    input: { q?: string; status?: number; enterprise?: boolean; sort: SortSpec } & ListQuery,
  ): Promise<PageResult<UserRecord>>;

  // ---- API Key ----
  insertKey(db: DbLike, input: ApiKeyInsert): Promise<ApiKeyRecord>;
  listKeysByUser(
    db: DbLike,
    input: { userId: number } & ListQuery,
  ): Promise<PageResult<ApiKeyRecord>>;
  findOwnedKey(db: DbLike, input: { userId: number; keyId: number }): Promise<ApiKeyRecord | null>;
  patchKey(
    db: DbLike,
    input: { userId: number; keyId: number; patch: ApiKeyPatch },
  ): Promise<ApiKeyRecord | null>;
  revokeKey(db: DbLike, input: { userId: number; keyId: number }): Promise<ApiKeyRecord | null>;
  listAdminKeys(
    db: DbLike,
    input: { q?: string; userId?: number; status?: number; sort: SortSpec } & ListQuery,
  ): Promise<PageResult<ApiKeyRecord>>;
  adminPatchKey(
    db: DbLike,
    input: { keyId: number; patch: AdminApiKeyPatch },
  ): Promise<ApiKeyRecord | null>;
  findActiveKeyByKeyHash(db: DbLike, keyHash: string): Promise<ActiveKeyRecord | null>;
  rebindSubscription(
    db: DbLike,
    input: { fromSubscriptionId: number; toSubscriptionId: number },
  ): Promise<{ keys: number; apps: number }>;

  // ---- Application ----
  insertApp(db: DbLike, input: AppInsert): Promise<AppRecord>;
  listAppsByUser(db: DbLike, input: { userId: number } & ListQuery): Promise<PageResult<AppRecord>>;
  findOwnedApp(db: DbLike, input: { userId: number; appId: number }): Promise<AppRecord | null>;
  disableApp(db: DbLike, input: { userId: number; appId: number }): Promise<AppRecord | null>;
  rotateAppSecret(
    db: DbLike,
    input: { userId: number; appId: number; clientSecretHash: string },
  ): Promise<AppRecord | null>;
  findActiveAppByAppId(db: DbLike, appId: string): Promise<ActiveAppRecord | null>;
  findActiveAppByClient(
    db: DbLike,
    input: { clientId: string; clientSecretHash: string },
  ): Promise<ActiveAppRecord | null>;

  // ---- 组织/成员/邀请 ----
  insertOrgWithOwner(db: DbLike, input: { name: string; ownerUserId: number }): Promise<OrgRecord>;
  findOrg(db: DbLike, orgId: number): Promise<OrgRecord | null>;
  findActiveMembership(
    db: DbLike,
    input: { orgId: number; userId: number },
  ): Promise<MembershipRecord | null>;
  listMembershipsForUser(db: DbLike, userId: number): Promise<readonly OrgMembershipView[]>;
  listMembers(db: DbLike, orgId: number): Promise<readonly MemberView[]>;
  countActiveMembers(db: DbLike, orgId: number): Promise<number>;
  countPendingInvitations(db: DbLike, orgId: number): Promise<number>;
  insertInvitation(db: DbLike, input: InvitationInsert): Promise<InvitationWithToken>;
  findInvitationByToken(db: DbLike, token: string): Promise<InvitationSnapshot | null>;
  /** owner 视角待接受(未过期 pending)列表;投影永不包含 token */
  listPendingInvitations(db: DbLike, orgId: number): Promise<readonly InvitationRecord[]>;
  revokeInvitation(db: DbLike, input: { orgId: number; invitationId: number }): Promise<boolean>;
  insertOrReviveMember(
    db: DbLike,
    input: { orgId: number; userId: number; role: string },
  ): Promise<void>;
  acceptInvitation(
    db: DbLike,
    input: { invitationId: number; acceptedByUserId: number },
  ): Promise<boolean>;
  findActiveOrgSubscription(
    db: DbLike,
    orgId: number,
  ): Promise<{ id: number; quantity: number } | null>;
  /** FOR UPDATE 行锁——只可在事务内调用(席位串行化,G8) */
  lockActiveOrgSubscription(
    db: DbLike,
    orgId: number,
  ): Promise<{ id: number; quantity: number } | null>;
  patchMember(
    db: DbLike,
    input: { orgId: number; userId: number; patch: MemberLimitsPatch },
  ): Promise<MembershipRecord | null>;
  removeMember(db: DbLike, input: { orgId: number; userId: number }): Promise<boolean>;
  /** 订阅绑定守卫:owner 本人或所属组织 active 成员可用;返回 {属主 userId, orgId|null} */
  findUsableSubscription(
    db: DbLike,
    input: { userId: number; subscriptionId: number },
  ): Promise<{ userId: number; orgId: number | null } | null>;
  memberLimits(
    db: DbLike,
    input: { orgId: number; userId: number },
  ): Promise<{ dailySpendLimit: string | null; monthlyQuota: string | null } | null>;

  // ---- 推荐/拉新参数 ----
  inviterActive(db: DbLike, inviterUserId: number): Promise<boolean>;
  insertReferral(
    db: DbLike,
    input: { inviterUserId: number; inviteeUserId: number },
  ): Promise<'created' | 'already_referred'>;
  listInvitees(
    db: DbLike,
    input: { inviterUserId: number; limit: number },
  ): Promise<readonly InviteeView[]>;
  getMarketingSettings(db: DbLike): Promise<MarketingSettingsRecord>;
  upsertMarketingSettings(
    db: DbLike,
    input: { patch: MarketingSettingsPatch; updatedBy: number | null },
  ): Promise<MarketingSettingsRecord>;
  listReferralRelations(
    db: DbLike,
    input: { q?: string } & ListQuery,
  ): Promise<PageResult<RelationView>>;
  setReferralRelationStatus(
    db: DbLike,
    input: { relationId: number; status: number },
  ): Promise<RelationView | null>;
}
