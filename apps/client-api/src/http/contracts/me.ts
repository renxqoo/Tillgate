/**
 * 账户资料契约：显示名修补。
 */
import * as z from 'zod';

export const displayNameSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
});
