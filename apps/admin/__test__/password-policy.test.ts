/**
 * 管理员改密表单校验行为规格（§10.1.3 边界：空值/长度界/一致性/新旧相同）。
 * 键值与 messages 的 changePassword.errors.* 一一对应（i18n parity 由 zh/en 同步约定）。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD_MAX,
  ADMIN_PASSWORD_MIN,
  validatePasswordChange,
} from '../src/features/auth/password-policy';

const base = {
  oldPassword: 'old-secret',
  newPassword: 'new-secret',
  confirmPassword: 'new-secret',
};

describe('validatePasswordChange（管理员改密校验）', () => {
  it('合法输入通过', () => {
    expect(validatePasswordChange(base)).toBeNull();
  });

  it('任一字段为空 → required', () => {
    expect(validatePasswordChange({ ...base, oldPassword: '' })).toBe('required');
    expect(validatePasswordChange({ ...base, newPassword: '' })).toBe('required');
    expect(validatePasswordChange({ ...base, confirmPassword: '' })).toBe('required');
  });

  it('确认与新密码不一致 → mismatch', () => {
    expect(validatePasswordChange({ ...base, confirmPassword: 'other' })).toBe('mismatch');
  });

  it('长度下界（8）闭区间：恰 8 通过、7 拒绝；上界（128）同理', () => {
    const pass8 = 'a'.repeat(ADMIN_PASSWORD_MIN);
    expect(
      validatePasswordChange({ ...base, newPassword: pass8, confirmPassword: pass8 }),
    ).toBeNull();
    const pass7 = 'a'.repeat(ADMIN_PASSWORD_MIN - 1);
    expect(validatePasswordChange({ ...base, newPassword: pass7, confirmPassword: pass7 })).toBe(
      'tooShort',
    );
    const pass129 = 'a'.repeat(ADMIN_PASSWORD_MAX + 1);
    expect(
      validatePasswordChange({ ...base, newPassword: pass129, confirmPassword: pass129 }),
    ).toBe('tooLong');
  });

  it('新密码与当前密码相同 → sameAsOld', () => {
    expect(
      validatePasswordChange({
        ...base,
        newPassword: base.oldPassword,
        confirmPassword: base.oldPassword,
      }),
    ).toBe('sameAsOld');
  });
});
