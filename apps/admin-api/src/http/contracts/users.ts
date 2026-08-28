/**
 * 用户/Key 域契约。
 * PATCH 封禁语义：freezeReason 只能随封禁（status=1）一并设置——状态语义不二义。
 */
import * as z from 'zod';
import { nonNegativeMoneyString, positiveMoneyString, signedNonZeroMoneyString } from './common';

export const USER_SORTS = ['id', 'subject', 'createdAt', 'lastLoginAt'] as const;
export const KEY_SORTS = ['id', 'name', 'status', 'lastUsedAt', 'createdAt'] as const;
export const USER_AUDIT_SORTS = ['id', 'action', 'createdAt'] as const;

const usersListQueryExtra = z.object({
  status: z.coerce.number().int().min(0).max(2).optional(),
  enterprise: z.enum(['0', '1']).optional(),
});

const userPatchSchema = z
  .object({
    status: z.number().int().min(0).max(2).optional(),
    rateCardId: z.number().int().positive().nullable().optional(),
    rpmLimit: z.number().int().min(1).nullable().optional(),
    tpmLimit: z.number().int().min(1).nullable().optional(),
    dailySpendLimit: nonNegativeMoneyString.nullable().optional(),
    /** displayName 不支持置空清除（accounts 动词词表无 null 形——显式 400,不静默忽略） */
    displayName: z.string().max(64).optional(),
    email: z.string().email().max(255).nullable().optional(),
    isEnterprise: z.boolean().optional(),
    freezeReason: z.string().max(128).nullable().optional(),
    /** 透支上限——不进 accounts patch,路由拆给 wallet.setCreditLimit */
    creditLimit: nonNegativeMoneyString.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.freezeReason != null && value.status !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'freezeReason can only be set together with ban (status=1)',
      });
    }
  });

const adjustSchema = z.object({
  amount: signedNonZeroMoneyString,
  remark: z.string().max(255).optional(),
});

const giftSchema = z.object({
  amount: positiveMoneyString,
  remark: z.string().max(255).optional(),
});

/** from/to 校验但忽略（日期过滤未启用;非法日期仍 400） */
const transactionsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const keysListQueryExtra = z.object({
  userId: z.coerce.number().int().positive().optional(),
  status: z.coerce.number().int().min(0).max(1).optional(),
});

const keyPatchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
  dailySpendLimit: nonNegativeMoneyString.nullable().optional(),
  status: z.number().int().min(0).max(1).optional(),
});

export const usersContracts = {
  listQueryExtra: usersListQueryExtra,
  patch: userPatchSchema,
  adjust: adjustSchema,
  gift: giftSchema,
  transactionsQuery: transactionsQuerySchema,
} as const;

export const keysContracts = {
  listQueryExtra: keysListQueryExtra,
  patch: keyPatchSchema,
} as const;
