/**
 * admin RBAC 旅程 e2e（全真装配——真实 PG +
 * 真监听 + identity 签发真 admin-realm 令牌）。旅程专属行 e2e-rbac-* 前缀,结束直删。
 *
 * 覆盖面：
 *   E viewer 拒绝面（读 200/写 403/me 权限集——拒绝矩阵的真装配抽样）;
 *   F super_admin 回填不变性（既有全权限行为零漂移）;
 *   G admins 管理旅程（邀请制创建（SMTP 未配 inviteSent:false 不回滚）→
 *      令牌消费激活 → 凭据可用 → 已激活后旧链接作废 → 降权同令牌即时生效 →
 *      自改拒绝 → 409 冲突 + 凭据被占补偿回滚——不留废号）。
 * journey.test.ts 零改动全绿 = 既有旅程回归锁（同套件运行时验证）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { admins, identityCredentials, identityPasswords, roles as rolesTable } from '@tillgate/db';
import { call, jsonHeaders, setupE2EAdmin, teardownE2EAdmin, type E2EAdminWorld } from './kit';

let world: E2EAdminWorld | null = null;

beforeAll(async () => {
  world = await setupE2EAdmin();
}, 60_000);

/** 本旅程创建的 admin id（含 viewer 探针行;清理面） */
const createdAdminIds: number[] = [];
/** 占位凭据挂在 provision 用户名下（清理面——用户行按 kit 惯例保留） */
const occupiedCredentialUserIds: number[] = [];

afterAll(async () => {
  if (world === null) return;
  // 旅程专属行直删（audit FK ON DELETE SET NULL;identity 凭据/密码行同步清理）
  await world.assembly.db
    .delete(identityPasswords)
    .where(inArray(identityPasswords.userId, createdAdminIds));
  await world.assembly.db
    .delete(identityCredentials)
    .where(inArray(identityCredentials.userId, [...createdAdminIds, ...occupiedCredentialUserIds]));
  await world.assembly.db.delete(admins).where(inArray(admins.id, createdAdminIds));
  await teardownE2EAdmin(world);
});

function w(): E2EAdminWorld {
  if (world === null) throw new Error('e2e world not ready');
  return world;
}

/** 直插管理员行（无凭据——令牌直签;角色按 code 查 roles）并签发真会话令牌 */
async function adminWithRole(roleCode: string, email: string): Promise<string> {
  const [roleRow] = await w()
    .assembly.db.select({ id: rolesTable.id })
    .from(rolesTable)
    .where(eq(rolesTable.code, roleCode));
  if (roleRow == null) throw new Error(`role ${roleCode} missing (run migrations 0082)`);
  const [row] = await w()
    .assembly.db.insert(admins)
    .values({
      email,
      passwordHash: 'identity-managed',
      roleId: roleRow.id,
      displayName: `e2e-rbac ${roleCode}`,
    })
    .returning({ id: admins.id });
  if (row == null) throw new Error('insert admins returned no row');
  createdAdminIds.push(row.id);
  return w().assembly.identity.sessions.sign({
    realm: 'admin',
    subjectId: row.id,
    ttlSec: 600,
  });
}

async function callAs(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${w().base}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** 角色种子 id（0082 保证存在;按 code 查——不硬编码自增序） */
async function roleIdOf(code: string): Promise<number> {
  const [row] = await w()
    .assembly.db.select({ id: rolesTable.id })
    .from(rolesTable)
    .where(eq(rolesTable.code, code));
  if (row == null) throw new Error(`role ${code} missing`);
  return row.id;
}
const operatorRoleId = () => roleIdOf('operator');
const viewerRoleId = () => roleIdOf('viewer');

describe('E. viewer 拒绝面（v2 种子等价 静态矩阵——真装配抽样）', () => {
  it('读动词 200 / 写动词 403 insufficient_permission / me 权限集只读', async () => {
    const token = await adminWithRole('viewer', `e2e-rbac-viewer-${Date.now()}@e2e.invalid`);

    for (const path of ['/v1/users', '/v1/channels', '/v1/logs']) {
      const res = await callAs(token, path);
      expect(res.status, `GET ${path}`).toBe(200);
    }

    for (const [method, path, body] of [
      ['PUT', '/v1/settings/billing-timezone', { timezone: 'Asia/Shanghai' }],
      ['POST', '/v1/channels', {}],
    ] as const) {
      const res = await callAs(token, path, {
        method,
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'admin.insufficient_permission' } });
    }

    // admins 域对 viewer 完全不可见（读也拒绝）
    const adminList = await callAs(token, '/v1/admins');
    expect(adminList.status).toBe(403);

    const me = await callAs(token, '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toMatchObject({ code: 'viewer', isSuper: false });
    const permissions = me.body.permissions as string[];
    expect(permissions).not.toContain('users:write');
    expect(permissions).not.toContain('admins:read');
    expect(permissions.every((permission) => permission.endsWith(':read'))).toBe(true);
  });
});

describe('F. super_admin 回填不变性（0081 迁移 = 既有行为零漂移）', () => {
  it('admins 域全通 + 设置写动词放行（写回当前值,幂等无数据漂移）', async () => {
    const list = await call(w(), '/v1/admins');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.rows)).toBe(true);

    const current = await call(w(), '/v1/settings/billing-timezone');
    expect(current.status).toBe(200);
    const timezone = (current.body.timezone as string) ?? 'Asia/Shanghai';
    const written = await call(w(), '/v1/settings/billing-timezone', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ timezone }),
    });
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ timezone });
  });
});

describe('G. admins 管理旅程（邀请制创建→令牌激活→降权即时生效→自改拒绝→冲突补偿）', () => {
  it('邀请制创建(SMTP 未配 inviteSent:false 不回滚) → 令牌消费激活 → 凭据可用 → 降权 403', async () => {
    const email = `e2e-rbac-op-${Date.now()}@e2e.invalid`;
    const created = await call(w(), '/v1/admins', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        email,
        displayName: 'e2e-rbac-op',
        roleId: await operatorRoleId(),
      }),
    });
    expect(created.status).toBe(201);
    // e2e 世界 SMTP 未配置——创建成功但邀请邮件未投递(用户裁决:列表重发补救)
    expect(created.body).toMatchObject({
      email,
      role: 'operator',
      status: 0,
      hasPassword: false,
      inviteSent: false,
    });
    const operatorId = created.body.id as number;
    // id ≥1e9 段（identity_passwords 扁平主键防串号）
    expect(operatorId).toBeGreaterThanOrEqual(1_000_000_000);
    createdAdminIds.push(operatorId);

    // 「邮件链接」替身：生产路径由创建/重发签发,这里经同一 Redis store 取令牌明文
    const inviteToken = await w().assembly.invites.issue(operatorId);
    const activated = await call(w(), '/v1/auth/reset-password', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ token: inviteToken, password: 'e2e-invite-pass-123' }),
    });
    expect(activated.status).toBe(200);
    expect(activated.body).toEqual({ ok: true });

    // 凭据真实落库：密码鉴别命中新建管理员
    const authed = await w().assembly.identity.passwords.authenticate({
      identifier: { kind: 'email', value: email },
      password: 'e2e-invite-pass-123',
    });
    expect(authed.userId).toBe(operatorId);

    // 激活后再持有的邀请令牌（过期邮件里的旧链接）一律作废——泄露不可改密
    const stale = await w().assembly.invites.issue(operatorId);
    const replay = await call(w(), '/v1/auth/reset-password', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ token: stale, password: 'hijack-pass-12345' }),
    });
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: { code: 'admin.admin_reset_token_invalid' } });

    // 列表投影：激活后 hasPassword=true（重发按钮显隐的单一事实）
    const list = await call(w(), '/v1/admins');
    const row = (list.body.rows as Array<{ id: number; hasPassword: boolean }>).find(
      (r) => r.id === operatorId,
    );
    expect(row?.hasPassword).toBe(true);

    // operator 令牌（降权前签发）：settings:write 放行
    const token = await w().assembly.identity.sessions.sign({
      realm: 'admin',
      subjectId: operatorId,
      ttlSec: 600,
    });
    const before = await callAs(token, '/v1/settings/billing-timezone', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ timezone: 'Asia/Shanghai' }),
    });
    expect(before.status).toBe(200);

    // 降权 viewer：同一令牌（role 不嵌 JWT,属主回查每请求现读,即时生效）
    const demoted = await call(w(), `/v1/admins/${operatorId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ roleId: await viewerRoleId() }),
    });
    expect(demoted.status).toBe(200);
    expect(demoted.body).toMatchObject({ roleId: await viewerRoleId() });

    const after = await callAs(token, '/v1/settings/billing-timezone', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ timezone: 'Asia/Shanghai' }),
    });
    expect(after.status).toBe(403);
    expect(after.body).toMatchObject({ error: { code: 'admin.insufficient_permission' } });
  });

  it('自改守卫（D6）：改自身 role/status 400;displayName 可改自身', async () => {
    const selfRole = await call(w(), `/v1/admins/${w().adminId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ roleId: await viewerRoleId() }),
    });
    expect(selfRole.status).toBe(400);
    expect(selfRole.body).toMatchObject({ error: { code: 'admin.cannot_modify_self' } });

    const selfBan = await call(w(), `/v1/admins/${w().adminId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 1 }),
    });
    expect(selfBan.status).toBe(400);

    const selfName = await call(w(), `/v1/admins/${w().adminId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ displayName: 'e2e-rbac-self' }),
    });
    expect(selfName.status).toBe(200);
  });

  it('email 冲突 409（admins 表唯一）+ 凭据被占补偿回滚（不留废号）', async () => {
    const email = `e2e-rbac-conflict-${Date.now()}@e2e.invalid`;
    const first = await call(w(), '/v1/admins', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        email,
        roleId: await roleIdOf('support'),
      }),
    });
    expect(first.status).toBe(201);
    const conflictId = first.body.id as number;
    createdAdminIds.push(conflictId);

    // 同 email 再建：admins 表唯一索引兜底 → 409
    const dup = await call(w(), '/v1/admins', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        email,
        roleId: await roleIdOf('viewer'),
      }),
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: { code: 'control_plane.admin_email_taken' } });
  });

  it('凭据被占补偿回滚：email 被其他身份占用 → 409 且不留废号资料行', async () => {
    // 真实场景形态：email 已被用户端账号注册为凭据（identity_credentials 全局命名空间）
    const user = await w().provisionUser();
    const email = `e2e-rbac-occupied-${Date.now()}@e2e.invalid`;
    await w().assembly.identity.credentials.register({
      userId: user.id,
      identifier: { kind: 'email', value: email },
    });
    occupiedCredentialUserIds.push(user.id);

    const orphan = await call(w(), '/v1/admins', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        email,
        roleId: await roleIdOf('viewer'),
      }),
    });
    expect(orphan.status).toBe(409);
    expect(orphan.body).toMatchObject({ error: { code: 'control_plane.admin_email_taken' } });
    // 补偿收回：该 email 无 admins 行残留（「创建成功但登不上」的废号不存在）
    const leftover = await w()
      .assembly.db.select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, email));
    expect(leftover).toHaveLength(0);
  });
});
