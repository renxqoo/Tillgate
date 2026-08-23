/**
 * 管理员资料用例族（G2）契约测试：按 id/邮箱查（命中/未命中/邮箱归一）、
 * 最近登录推进、2FA 开关翻转——经内存 store 替身（SQL 行为等价由 postgres.real 承担）。
 * 投影封闭性：AdminRecord 不含密码/2FA 密钥列（identity 七表单一真相,G1/G2）。
 */
import { describe, expect, it } from 'vitest';
import { findAdmin } from '../src/application/admins/find-admin';
import { findAdminByEmail } from '../src/application/admins/find-admin-by-email';
import { touchLastLogin } from '../src/application/admins/touch-last-login';
import { setTwoFactorEnabled } from '../src/application/admins/set-two-factor-enabled';
import { createMemoryAdminStore } from './memory';

const record = {
  id: 7,
  email: 'ops@tokenlens.dev',
  displayName: 'Ops',
  status: 0,
  twoFactorEnabled: false,
  lastLoginAt: null,
  createdAt: new Date(0),
};

function setup() {
  const store = createMemoryAdminStore([record]);
  return { deps: { db: {} as never, store }, store };
}

describe('admins（G2 管理员资料用例族）', () => {
  it('按 id/邮箱查:命中投影封闭(无密码列);未命中 null;邮箱 trim+小写归一', async () => {
    const { deps } = setup();
    const byId = await findAdmin(deps, 7);
    expect(byId).toEqual(record);
    expect(Object.keys(byId!)).not.toContain('passwordHash');
    expect(await findAdmin(deps, 999)).toBeNull();
    // 归一化在用例层（app 传入的原始形态也能命中）
    const byEmail = await findAdminByEmail(deps, '  OPS@TokenLens.dev ');
    expect(byEmail?.id).toBe(7);
    expect(await findAdminByEmail(deps, 'no@x')).toBeNull();
  });

  it('touchLastLogin 推进时间戳;setTwoFactorEnabled 翻转;未知 id 静默无操作', async () => {
    const { deps, store } = setup();
    await touchLastLogin(deps, 7);
    expect(store.rows.get(7)?.lastLoginAt).not.toBeNull();
    await setTwoFactorEnabled(deps, { adminId: 7, enabled: true });
    expect(store.rows.get(7)?.twoFactorEnabled).toBe(true);
    await setTwoFactorEnabled(deps, { adminId: 404, enabled: true });
    await touchLastLogin(deps, 404);
    expect(store.rows.has(404)).toBe(false);
  });
});
