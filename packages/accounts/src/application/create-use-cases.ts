/**
 * 用例装配器:把 UseCaseContext 绑定为可调用动词表(facade 的实现体)。
 * 一动词一文件(铁律 5);本文件只做绑定,不含逻辑。
 */
import type { UseCaseContext } from './context.js';
import { provisionLocalAccount } from './provision-local-account.js';
import { provisionOAuthAccount } from './provision-oauth-account.js';
import { getProfile } from './get-profile.js';
import { updateDisplayName } from './update-display-name.js';
import { adminListUsers, type AdminListUsersInput } from './admin-list-users.js';
import { adminGetUser } from './admin-get-user.js';
import { adminPatchUser, type AdminUserPatchInput } from './admin-patch-user.js';
import { userExists, userIsEnterprise, userRateCardBinding, memberLimits } from './reads.js';
import { createKey, type CreateKeyInput } from './create-key.js';
import { listKeys } from './list-keys.js';
import { patchKey } from './patch-key.js';
import { rotateKey } from './rotate-key.js';
import { revokeKey } from './revoke-key.js';
import { adminListKeys, type AdminListKeysInput } from './admin-list-keys.js';
import { adminPatchKey } from './admin-patch-key.js';
import { resolveKeyByHash } from './resolve-key-by-hash.js';
import { rebindSubscription } from './rebind-subscription.js';
import { createApp } from './create-app.js';
import { listApps } from './list-apps.js';
import { disableApp } from './disable-app.js';
import { rotateAppSecret } from './rotate-app-secret.js';
import { resolveApp } from './resolve-app.js';
import { verifyAppClient } from './verify-app-client.js';
import { createOrg } from './create-org.js';
import { listMyOrgs } from './list-my-orgs.js';
import { getOrgDetail } from './get-org-detail.js';
import { inviteMember } from './invite-member.js';
import { revokeInvitation } from './revoke-invitation.js';
import { acceptInvitation } from './accept-invitation.js';
import { setMemberLimits } from './set-member-limits.js';
import { removeMember } from './remove-member.js';
import { grantSignupGift } from './grant-signup-gift.js';
import { applyReferral } from './apply-referral.js';
import { completeAccountOnboarding } from './complete-account-onboarding.js';
import { referralOverview } from './referral-overview.js';
import { getMarketingSettings } from './get-marketing-settings.js';
import { updateMarketingSettings } from './update-marketing-settings.js';
import { listReferralRelations } from './list-referral-relations.js';
import { setReferralRelationStatus } from './set-referral-relation-status.js';
import type { KeyFieldsInput } from './key-fields.js';

/** 全部用例动词(只读视图;调用形态 verb(input)) */
export interface AccountUseCases {
  // 建号与资料
  provisionLocalAccount(input: { email: string; displayName?: string }): ReturnType<typeof provisionLocalAccount>;
  provisionOAuthAccount(input: { issuer: string; subject: string; email?: string; displayName?: string }): ReturnType<typeof provisionOAuthAccount>;
  getProfile(userId: number): ReturnType<typeof getProfile>;
  updateDisplayName(input: { userId: number; displayName: string }): ReturnType<typeof updateDisplayName>;
  // 管理面用户
  adminListUsers(input: AdminListUsersInput): ReturnType<typeof adminListUsers>;
  adminGetUser(userId: number): ReturnType<typeof adminGetUser>;
  adminPatchUser(input: { userId: number; patch: AdminUserPatchInput; adminId: number }): ReturnType<typeof adminPatchUser>;
  // 跨能力只读探针
  userExists(userId: number): Promise<boolean>;
  userIsEnterprise(userId: number): Promise<boolean>;
  userRateCardBinding(userId: number): Promise<number | null>;
  memberLimits(input: { orgId: number; userId: number }): ReturnType<typeof memberLimits>;
  // API Key
  createKey(input: CreateKeyInput): ReturnType<typeof createKey>;
  listKeys(input: { userId: number; page?: number; limit?: number }): ReturnType<typeof listKeys>;
  patchKey(input: { userId: number; keyId: number; patch: KeyFieldsInput }): ReturnType<typeof patchKey>;
  rotateKey(input: { userId: number; keyId: number }): ReturnType<typeof rotateKey>;
  revokeKey(input: { userId: number; keyId: number }): ReturnType<typeof revokeKey>;
  adminListKeys(input: AdminListKeysInput): ReturnType<typeof adminListKeys>;
  adminPatchKey(input: { keyId: number; patch: KeyFieldsInput & { status?: number }; adminId: number }): ReturnType<typeof adminPatchKey>;
  resolveKeyByHash(keyHash: string): ReturnType<typeof resolveKeyByHash>;
  rebindSubscription(input: { fromSubscriptionId: number; toSubscriptionId: number }): ReturnType<typeof rebindSubscription>;
  // Application
  createApp(input: Parameters<typeof createApp>[1]): ReturnType<typeof createApp>;
  listApps(input: { userId: number; page?: number; limit?: number }): ReturnType<typeof listApps>;
  disableApp(input: { userId: number; appId: number }): ReturnType<typeof disableApp>;
  rotateAppSecret(input: { userId: number; appId: number }): ReturnType<typeof rotateAppSecret>;
  resolveApp(appId: string): ReturnType<typeof resolveApp>;
  verifyAppClient(input: { clientId: string; clientSecret: string }): ReturnType<typeof verifyAppClient>;
  // 组织
  createOrg(input: { ownerUserId: number; name: string }): ReturnType<typeof createOrg>;
  listMyOrgs(userId: number): ReturnType<typeof listMyOrgs>;
  getOrgDetail(input: { userId: number; orgId: number }): ReturnType<typeof getOrgDetail>;
  // 邀请与成员
  inviteMember(input: { orgId: number; operatorUserId: number; email: string }): ReturnType<typeof inviteMember>;
  revokeInvitation(input: { orgId: number; operatorUserId: number; invitationId: number }): ReturnType<typeof revokeInvitation>;
  acceptInvitation(input: { token: string; acceptorUserId: number }): ReturnType<typeof acceptInvitation>;
  setMemberLimits(input: Parameters<typeof setMemberLimits>[1]): ReturnType<typeof setMemberLimits>;
  removeMember(input: { orgId: number; operatorUserId: number; memberUserId: number }): ReturnType<typeof removeMember>;
  // 推荐与拉新参数
  grantSignupGift(userId: number): ReturnType<typeof grantSignupGift>;
  applyReferral(input: { inviteeUserId: number; affCode: string }): ReturnType<typeof applyReferral>;
  completeAccountOnboarding(input: { userId: number; affCode?: string }): ReturnType<typeof completeAccountOnboarding>;
  referralOverview(input: { userId: number; frontendBaseUrl: string }): ReturnType<typeof referralOverview>;
  getMarketingSettings(): ReturnType<typeof getMarketingSettings>;
  updateMarketingSettings(input: Parameters<typeof updateMarketingSettings>[1]): ReturnType<typeof updateMarketingSettings>;
  listReferralRelations(input: { q?: string; page?: number; limit?: number }): ReturnType<typeof listReferralRelations>;
  setReferralRelationStatus(input: { relationId: number; status: number; adminId: number }): ReturnType<typeof setReferralRelationStatus>;
}

export function createAccountUseCases(ctx: UseCaseContext): AccountUseCases {
  return {
    provisionLocalAccount: (input) => provisionLocalAccount(ctx, input),
    provisionOAuthAccount: (input) => provisionOAuthAccount(ctx, input),
    getProfile: (userId) => getProfile(ctx, userId),
    updateDisplayName: (input) => updateDisplayName(ctx, input),
    adminListUsers: (input) => adminListUsers(ctx, input),
    adminGetUser: (userId) => adminGetUser(ctx, userId),
    adminPatchUser: (input) => adminPatchUser(ctx, input),
    userExists: (userId) => userExists(ctx, userId),
    userIsEnterprise: (userId) => userIsEnterprise(ctx, userId),
    userRateCardBinding: (userId) => userRateCardBinding(ctx, userId),
    memberLimits: (input) => memberLimits(ctx, input),
    createKey: (input) => createKey(ctx, input),
    listKeys: (input) => listKeys(ctx, input),
    patchKey: (input) => patchKey(ctx, input),
    rotateKey: (input) => rotateKey(ctx, input),
    revokeKey: (input) => revokeKey(ctx, input),
    adminListKeys: (input) => adminListKeys(ctx, input),
    adminPatchKey: (input) => adminPatchKey(ctx, input),
    resolveKeyByHash: (keyHash) => resolveKeyByHash(ctx, keyHash),
    rebindSubscription: (input) => rebindSubscription(ctx, input),
    createApp: (input) => createApp(ctx, input),
    listApps: (input) => listApps(ctx, input),
    disableApp: (input) => disableApp(ctx, input),
    rotateAppSecret: (input) => rotateAppSecret(ctx, input),
    resolveApp: (appId) => resolveApp(ctx, appId),
    verifyAppClient: (input) => verifyAppClient(ctx, input),
    createOrg: (input) => createOrg(ctx, input),
    listMyOrgs: (userId) => listMyOrgs(ctx, userId),
    getOrgDetail: (input) => getOrgDetail(ctx, input),
    inviteMember: (input) => inviteMember(ctx, input),
    revokeInvitation: (input) => revokeInvitation(ctx, input),
    acceptInvitation: (input) => acceptInvitation(ctx, input),
    setMemberLimits: (input) => setMemberLimits(ctx, input),
    removeMember: (input) => removeMember(ctx, input),
    grantSignupGift: (userId) => grantSignupGift(ctx, userId),
    applyReferral: (input) => applyReferral(ctx, input),
    completeAccountOnboarding: (input) => completeAccountOnboarding(ctx, input),
    referralOverview: (input) => referralOverview(ctx, input),
    getMarketingSettings: () => getMarketingSettings(ctx),
    updateMarketingSettings: (input) => updateMarketingSettings(ctx, input),
    listReferralRelations: (input) => listReferralRelations(ctx, input),
    setReferralRelationStatus: (input) => setReferralRelationStatus(ctx, input),
  };
}
