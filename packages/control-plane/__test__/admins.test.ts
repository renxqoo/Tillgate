/**
 * 管理员资料用例族（G2）契约测试：按 id/邮箱查（命中/未命中/邮箱归一）、
 * 最近登录推进、2FA 开关翻转、RBAC 管理面三动词（列表/建行/更新——词表守卫、
 * 重名 23505 翻译、未命中 404）——经内存 store 替身（SQL 行为等价由 postgres.real 承担）。
 * 投影封闭性：AdminRecord 不含密码/2FA 密钥列（identity 七表单一真相,G1/G2）。
 */
import { describe, expect, it } from 'vitest';
import { findAdmin } from '../src/application/admins/find-admin';
import { findAdminByEmail } from '../src/application/admins/find-admin-by-email';
import { touchLastLogin } from '../src/application/admins/touch-last-login';
import { setTwoFactorEnabled } from '../src/application/admins/set-two-factor-enabled';
import { listAdmins } from '../src/application/admins/list-admins';
import { createAdmin } from '../src/application/admins/create-admin';
import { updateAdmin } from '../src/application/admins/update-admin';
import { createMemoryAdminStore } from './memory';

const record = {
  id: 7,
  email: 'ops@tokenlens.dev',
  displayName: 'Ops',
  status: 0,
  role: 'super_admin' as const,
  twoFactorEnabled: false,
  lastLoginAt: null,
  createdAt: new Date(0),
};

function setup() {
  const store = createMemoryAdminStore([record]);
  // createAdmin 开事务（id 段分配与插入原子）——替身事务桩直接透传 fake tx
  const db = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as never;
  return { deps: { db, store }, store };
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

  it('list:id 升序全量;create:邮箱归一+落角色;重名 23505 → admin_email_taken;非法角色拒绝', async () => {
    const { deps, store } = setup();
    const created = await createAdmin(
      { db: deps.db, store },
      { email: '  Newbie@TokenLens.dev ', displayName: 'Newbie', role: 'viewer' },
    );
    expect(created.email).toBe('newbie@tokenlens.dev');
    expect(created.role).toBe('viewer');
    expect(created.status).toBe(0);

    const rows = await listAdmins(deps);
    expect(rows.map((r) => r.id)).toEqual([7, created.id]);

    await expect(
      createAdmin(
        { db: deps.db, store },
        { email: 'OPS@tokenlens.dev', displayName: null, role: 'operator' },
      ),
    ).rejects.toMatchObject({ code: 'control_plane.admin_email_taken' });

    await expect(
      createAdmin({ db: deps.db, store }, { email: 'x@y.dev', displayName: null, role: 'boss' }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_admin_role' });
  });

  it('update:部分更新只动传入字段;未命中 null;非法角色拒绝', async () => {
    const { deps } = setup();
    const renamed = await updateAdmin(deps, { adminId: 7, displayName: 'Renamed' });
    expect(renamed?.displayName).toBe('Renamed');
    expect(renamed?.role).toBe('super_admin');

    const demoted = await updateAdmin(deps, { adminId: 7, role: 'operator', status: 1 });
    expect(demoted?.role).toBe('operator');
    expect(demoted?.status).toBe(1);
    expect(demoted?.displayName).toBe('Renamed');

    // 未命中返回 null（404 抛点在路由——admin.admin_not_found 单一码）
    expect(await updateAdmin(deps, { adminId: 404, role: 'viewer' })).toBeNull();

    await expect(updateAdmin(deps, { adminId: 7, role: 'ghost' as never })).rejects.toMatchObject({
      code: 'control_plane.invalid_admin_role',
    });
  });

  it('remove:补偿删除收回资料行(创建流程凭据注册失败路径)', async () => {
    const { deps, store } = setup();
    const created = await createAdmin(
      { db: deps.db, store },
      { email: 'temp@tokenlens.dev', displayName: null, role: 'support' },
    );
    await store.remove(deps.db, created.id);
    expect(await findAdmin(deps, created.id)).toBeNull();
  });
});
