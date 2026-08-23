/**
 * 组织契约：详情/邀请/撤销/接受/成员限额修补（金额与 Key 同口径）。
 */
import { z } from 'zod';
import { isValidSpendLimitInput } from './shared.js';

export const orgIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(255),
});

export const invitationParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  invitationId: z.coerce.number().int().positive(),
});

export const acceptInvitationSchema = z.object({ token: z.string().trim().min(1).max(64) });

export const memberPatchSchema = z.object({
  dailySpendLimit: z
    .string()
    .refine(isValidSpendLimitInput, 'Must be a positive amount (value too large or invalid format)')
    .nullable()
    .optional(),
  monthlyQuota: z
    .string()
    .refine(isValidSpendLimitInput, 'Must be a positive amount (value too large or invalid format)')
    .nullable()
    .optional(),
});
