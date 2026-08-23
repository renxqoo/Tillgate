/**
 * 管理员改密表单校验（纯函数,可测）：返回 i18n 键（changePassword.errors.*）或 null。
 * 长度口径与 admin-api 装配的 identity 策略一致（minLength 8 / maxLength 128,
 * assembly.ts passwordPolicy——服务端为唯一权威,此处仅提前拦截减少往返）。
 */
export const ADMIN_PASSWORD_MIN = 8;
export const ADMIN_PASSWORD_MAX = 128;

export interface PasswordChangeInput {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type PasswordChangeErrorKey = 'required' | 'mismatch' | 'tooShort' | 'tooLong' | 'sameAsOld';

export function validatePasswordChange(input: PasswordChangeInput): PasswordChangeErrorKey | null {
  if (input.oldPassword === '' || input.newPassword === '' || input.confirmPassword === '') {
    return 'required';
  }
  if (input.newPassword !== input.confirmPassword) return 'mismatch';
  if (input.newPassword.length < ADMIN_PASSWORD_MIN) return 'tooShort';
  if (input.newPassword.length > ADMIN_PASSWORD_MAX) return 'tooLong';
  if (input.newPassword === input.oldPassword) return 'sameAsOld';
  return null;
}
