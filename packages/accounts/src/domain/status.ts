/**
 * 账号状态词汇(accounts 域内使用形态)。
 * 物理真相是 db 包的 ACCOUNT_STATUS(users/admins 共用)——本处不 import db
 * (domain 零基础设施依赖),同一性由 __test__/domain-contract.test.ts 逐项相等锁定
 * (机制位与派生表逐项相等)。
 */
export const USER_STATUS = { ACTIVE: 0, BANNED: 1, DELETED: 2 } as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export const USER_STATUSES: readonly UserStatus[] = [0, 1, 2];

/** 凭证状态(api_keys/apps 共用形态:0 在用 / 1 终止) */
export const CREDENTIAL_STATUS = { ACTIVE: 0, REVOKED: 1 } as const;

export type CredentialStatus = (typeof CREDENTIAL_STATUS)[keyof typeof CREDENTIAL_STATUS];

/** 成员/邀请状态词汇(与 org_members/org_invitations DDL 注释同拍) */
export const MEMBER_STATUS = { ACTIVE: 0, LEFT: 1 } as const;
export const INVITATION_STATUS = { PENDING: 0, ACCEPTED: 1, REVOKED: 2 } as const;
/** 推荐/营销关系状态:0 有效 / 1 封禁(作弊停奖,历史不动) */
export const REFERRAL_STATUS = { ACTIVE: 0, BANNED: 1 } as const;

export const REFERRAL_STATUSES: readonly number[] = [
  REFERRAL_STATUS.ACTIVE,
  REFERRAL_STATUS.BANNED,
];
