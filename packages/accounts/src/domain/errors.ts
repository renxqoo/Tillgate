/**
 * 账号能力错误目录:码的唯一登记处,随包分发;face 装配期合成。
 * status 映射归 app face(category 默认 + 按码覆盖,如 invitation_expired 是 410)。
 */
import { defineErrorCatalog } from '@tillgate/errors';

export const AccountsErrors = defineErrorCatalog('accounts', {
  // ---- 用户与资料 ----
  user_not_found: { category: 'not_found', message: 'User not found', zh: '用户不存在' },
  email_taken: { category: 'conflict', message: 'Email already registered', zh: '邮箱已被注册' },
  email_invalid: {
    category: 'invalid_input',
    message: 'Invalid email address',
    zh: '邮箱格式不合法',
  },
  display_name_invalid: {
    category: 'invalid_input',
    message: 'Display name must be 1-64 characters after trim',
    zh: '显示名去除首尾空白后须为 1-64 字符',
  },
  user_patch_invalid: {
    category: 'invalid_input',
    message: 'User patch fields are inconsistent',
    zh: '用户补丁字段组合不合法',
  },
  rate_card_not_found: {
    category: 'not_found',
    message: 'Rate card not found',
    zh: '费率卡不存在',
  },
  rate_card_disabled: { category: 'conflict', message: 'Rate card disabled', zh: '费率卡已停用' },

  // ---- API Key ----
  key_not_found: { category: 'not_found', message: 'API key not found', zh: 'API Key 不存在' },
  key_already_revoked: {
    category: 'conflict',
    message: 'API key already revoked',
    zh: 'API Key 已吊销',
  },
  key_patch_invalid: {
    category: 'invalid_input',
    message: 'API key fields invalid',
    zh: 'API Key 字段不合法',
  },
  subscription_not_usable: {
    category: 'not_found',
    message: 'Subscription not usable for this user',
    zh: '订阅不可用',
  },

  // ---- Application ----
  app_not_found: { category: 'not_found', message: 'Application not found', zh: '应用不存在' },
  app_already_disabled: {
    category: 'conflict',
    message: 'Application already disabled',
    zh: '应用已禁用',
  },
  app_patch_invalid: {
    category: 'invalid_input',
    message: 'Application fields invalid',
    zh: '应用字段不合法',
  },
  app_scope_invalid: {
    category: 'invalid_input',
    message: 'App scope invalid',
    zh: '应用限制项不合法',
  },

  // ---- 组织/成员/邀请 ----
  org_not_found: { category: 'not_found', message: 'Organization not found', zh: '组织不存在' },
  org_forbidden: {
    category: 'forbidden',
    message: 'Owner role required',
    zh: '需要组织所有者权限',
  },
  org_no_subscription: {
    category: 'conflict',
    message: 'Organization has no active subscription',
    zh: '组织没有有效订阅',
  },
  seats_full: {
    category: 'conflict',
    message: 'All subscription seats are occupied',
    zh: '订阅席位已满',
  },
  invitations_full: {
    category: 'conflict',
    message: 'Too many pending invitations',
    zh: '待接受邀请数量已达上限',
  },
  invitation_invalid: {
    category: 'not_found',
    message: 'Invitation not found',
    zh: '邀请不存在或已失效',
  },
  invitation_revoked: { category: 'conflict', message: 'Invitation revoked', zh: '邀请已撤销' },
  invitation_already_accepted: {
    category: 'conflict',
    message: 'Invitation already accepted',
    zh: '邀请已被接受',
  },
  invitation_expired: { category: 'conflict', message: 'Invitation expired', zh: '邀请已过期' },
  invitation_email_mismatch: {
    category: 'forbidden',
    message: 'Invitation email does not match the account',
    zh: '邀请邮箱与当前账号不一致',
  },
  org_cannot_remove_owner: {
    category: 'conflict',
    message: 'Organization owner cannot be removed',
    zh: '不能移除组织所有者',
  },
  member_not_found: {
    category: 'not_found',
    message: 'Organization member not found',
    zh: '成员不存在',
  },
  member_limits_invalid: {
    category: 'invalid_input',
    message: 'Member limit values invalid',
    zh: '成员限额不合法',
  },
  relation_status_invalid: {
    category: 'invalid_input',
    message: 'Referral relation status invalid',
    zh: '推荐关系状态不合法',
  },
  org_name_invalid: {
    category: 'invalid_input',
    message: 'Organization name must be 1-64 characters after trim',
    zh: '组织名去除首尾空白后须为 1-64 字符',
  },

  // ---- 推荐与拉新参数 ----
  referral_invalid_code: {
    category: 'invalid_input',
    message: 'Invalid referral code',
    zh: '邀请码不合法',
  },
  referral_self_invite: {
    category: 'conflict',
    message: 'Cannot refer yourself',
    zh: '不能邀请自己',
  },
  referral_inviter_not_found: {
    category: 'not_found',
    message: 'Inviter not available',
    zh: '邀请人不可用',
  },
  referral_already_referred: {
    category: 'conflict',
    message: 'Invitee already referred',
    zh: '该用户已被邀请过',
  },
  marketing_settings_invalid: {
    category: 'invalid_input',
    message: 'Marketing settings values invalid',
    zh: '营销参数不合法',
  },
  relation_not_found: {
    category: 'not_found',
    message: 'Referral relation not found',
    zh: '推荐关系不存在',
  },
});
