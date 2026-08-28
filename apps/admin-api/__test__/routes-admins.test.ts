/**
 * 管理员管理面契约测试（RBAC admins 域）：
 * 列表信封/邀请制创建（仅挂标识 + 尽力投递邀请邮件,凭据被占补偿回滚——不留废号）/
 * 重发邀请前置校验矩阵/PATCH 部分更新 + 自改守卫/权限面（非 super_admin 403）。
 * 审计旁路形状由 e2e/admin/rbac 真装配断言（fakeDeps 的 postAudit 缺省不可覆写）。
 */
import { describe, expect, it, vi } from 'vitest';
import { identityErrors } from '@tillgate/identity';
import { controlPlaneErrors } from '@tillgate/control-plane';
import { createAdminApp } from '../src/app';
import type { AdminAppDeps } from '../src/app';
import { ADMIN_ID, authHeader, fakeDeps, inMemoryInvites } from './helpers';
import { defined } from './defined.js';

const json = { ...authHeader(), 'content-type': 'application/json' };

const record = {
  id: 1_000_000_001,
  email: 'new@tillgate.dev',
  displayName: 'New',
  status: 0,
  roleId: 2,
  twoFactorEnabled: false,
  lastLoginAt: null,
  createdAt: new Date(0),
};

function wire(overrides?: {
  create?: () => Promise<typeof record>;
  register?: () => Promise<unknown>;
  update?: () => Promise<typeof record | null>;
  list?: () => Promise<{ rows: (typeof record)[]; total: number }>;
  find?: () => Promise<typeof record | null>;
  /** passwords.exists 投影(返回已激活 userId 集) */
  passwordExists?: (userIds: number[]) => number[];
  /** 替身限内存形态(测试断言需读 tokens/cooldowns 内部态) */
  invites?: ReturnType<typeof inMemoryInvites>;
  sendInviteLink?: AdminAppDeps['sendInviteLink'];
  inviteLinkBase?: string | null;
  mailerConfigured?: () => boolean;
}) {
  const create = vi.fn(overrides?.create ?? (async () => record));
  const register = vi.fn(
    overrides?.register ?? (async () => ({ credentialId: 9, replayed: false })),
  );
  const remove = vi.fn(async () => {});
  const update = vi.fn(overrides?.update ?? (async () => record));
  const list = vi.fn(overrides?.list ?? (async () => ({ rows: [record], total: 1 })));
  const find = vi.fn(overrides?.find ?? (async () => record));
  const exists = vi.fn(async (input: { userIds: number[] }) =>
    (overrides?.passwordExists ?? (() => []))(input.userIds),
  );
  const invites = overrides?.invites ?? inMemoryInvites();
  // null 是合法形态(基地未配置)——按 undefined 判缺省,不用 ?? 吞显式 null
  const inviteLinkBase =
    overrides?.inviteLinkBase === undefined
      ? 'https://admin.example.com'
      : overrides.inviteLinkBase;
  // 缺省 SMTP 生效(邀请投递可用);「未配置」用例显式覆写
  const mailerConfigured = overrides?.mailerConfigured ?? (() => true);
  const app = createAdminApp(
    fakeDeps({
      controlPlane: { admins: { list, create, update, remove, find } },
      identity: { credentials: { register }, passwords: { exists } },
      invites,
      inviteLinkBase,
      ...(overrides?.sendInviteLink != null ? { sendInviteLink: overrides.sendInviteLink } : {}),
      mailerConfigured,
    }),
  );
  return { app, spies: { create, register, remove, update, list, find, exists }, invites };
}

const createBody = {
  email: 'New@Tillgate.dev ',
  displayName: 'New',
  roleId: 2,
};

describe('GET /v1/admins（统一列表契约）', () => {
  it('信封 {rows,total,page,pageSize};wire 投影含 role/hasPassword 不含密码列;查询参数透传 store', async () => {
    const { app, spies } = wire({ passwordExists: () => [record.id] });
    const res = await app.request('/v1/admins?page=2&page_size=5&q=ops&sort_by=email&order=desc', {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Record<string, unknown>[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body).toMatchObject({ total: 1, page: 2, pageSize: 5 });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: record.id,
      roleId: 2,
      status: 0,
      hasPassword: true,
    });
    expect(Object.keys(defined(body.rows[0], 'body.rows[0]'))).not.toContain('passwordHash');
    // 激活态批量投影:单条 exists 调用(IN 语义,防 N+1)
    expect(spies.exists).toHaveBeenCalledWith({ userIds: [record.id] });
    expect(spies.list).toHaveBeenCalledWith({
      q: 'ops',
      sortBy: 'email',
      order: 'desc',
      limit: 5,
      offset: 5,
    });
  });

  it('排序白名单外 400 invalid_sort_field;缺省 sort_by=id asc', async () => {
    const { app, spies } = wire();
    const bad = await app.request('/v1/admins?sort_by=passwordHash', { headers: authHeader() });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'admin.invalid_sort_field',
    );
    expect(spies.list).not.toHaveBeenCalled();

    const def = await app.request('/v1/admins', { headers: authHeader() });
    expect(def.status).toBe(200);
    // 缺省 = sort_by:id + listQuerySchema 缺省序 desc/页 20（统一列表契约口径）
    expect(spies.list).toHaveBeenCalledWith({
      sortBy: 'id',
      order: 'desc',
      limit: 20,
      offset: 0,
    });
  });

  it('权限面:viewer 403（admins 域仅 super_admin）', async () => {
    const base = fakeDeps({
      controlPlane: {
        admins: { list: async () => ({ rows: [], total: 0 }) },
      },
    });
    const viewerApp = createAdminApp({
      ...base,
      sessions: {
        validate: base.sessions.validate,
        owner: async () => ({ status: 0, grants: { isSuper: false, codes: [] } }),
      },
    });
    const res = await viewerApp.request('/v1/admins', { headers: authHeader() });
    // 403(fail-closed:未绑定/无权同面——具体码判定由 ACL 专测覆盖)
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/admins（邀请制创建）', () => {
  it('成功:资料行(email 归一)→ 仅挂凭据标识(无密码) → 邀请邮件投递 → 201 inviteSent', async () => {
    const sendInviteLink = vi.fn(async () => {});
    const { app, spies } = wire({ sendInviteLink });
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: record.id,
      roleId: 2,
      hasPassword: false,
      inviteSent: true,
    });
    expect(spies.create).toHaveBeenCalledWith({
      email: 'new@tillgate.dev',
      displayName: 'New',
      roleId: 2,
    });
    // 凭据注册不带密码——初始密码由本人经邮件一次性链接设置
    expect(spies.register).toHaveBeenCalledWith({
      userId: record.id,
      identifier: { kind: 'email', value: 'new@tillgate.dev' },
    });
    expect(sendInviteLink).toHaveBeenCalledWith(
      'new@tillgate.dev',
      'https://admin.example.com/reset-password?token=invite-token-1',
      { locale: 'en' },
    );
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it('SMTP 未配置:创建成功但 inviteSent:false,不投递不回滚(用户裁决:允许创建,列表重发补救)', async () => {
    const sendInviteLink = vi.fn(async () => {});
    const { app, spies } = wire({ sendInviteLink, mailerConfigured: () => false });
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ inviteSent: false });
    expect(sendInviteLink).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it('链接基地未配置(ADMIN_FRONTEND_URL 缺失):201 inviteSent:false', async () => {
    const sendInviteLink = vi.fn(async () => {});
    const { app } = wire({ sendInviteLink, inviteLinkBase: null });
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ inviteSent: false });
    expect(sendInviteLink).not.toHaveBeenCalled();
  });

  it('投递瞬断(sendMail 抛错):201 inviteSent:false 且不补偿回滚(回滚会留孤儿标识死锁同邮箱)', async () => {
    const sendInviteLink = vi.fn(async () => {
      throw new Error('smtp delivery failed');
    });
    const { app, spies } = wire({ sendInviteLink });
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ inviteSent: false });
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it('凭据被占（identity.identifier_taken）→ 补偿删行 + 409 admin_email_taken', async () => {
    const { app, spies } = wire({
      register: async () => {
        throw identityErrors.business('identifier_taken', { kind: 'email', value: 'x' });
      },
    });
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'control_plane.admin_email_taken',
    );
    expect(spies.remove).toHaveBeenCalledWith(record.id);
  });

  it('资料行重名（control_plane.admin_email_taken）→ 409,不碰 identity/补偿', async () => {
    const { app, spies } = wire({
      create: async () => {
        throw controlPlaneErrors.business('admin_email_taken', { email: 'x' });
      },
    });
    const res = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(409);
    expect(spies.register).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it('契约面:角色词表外 400;缺 role 400;password 字段已退役(多余键被剥离不参与语义)', async () => {
    const { app } = wire();
    const badRole = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ...createBody, roleId: 'boss' as never }),
    });
    expect(badRole.status).toBe(400);
    const missing = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'a@b.dev' }),
    });
    expect(missing.status).toBe(400);
    const legacy = await app.request('/v1/admins', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ...createBody, password: 'initial-pass-123' }),
    });
    expect(legacy.status).toBe(201);
    expect(await legacy.json()).toMatchObject({ inviteSent: true });
  });
});

describe('POST /v1/admins/:id/resend-invite（重发邀请）', () => {
  it('成功:前置通过 → 冷却占用 → 新令牌投递 → 200 {ok:true}', async () => {
    const sendInviteLink = vi.fn(async () => {});
    const { app, invites } = wire({ sendInviteLink });
    const res = await app.request(`/v1/admins/${record.id}/resend-invite`, {
      method: 'POST',
      headers: json,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendInviteLink).toHaveBeenCalledWith(
      'new@tillgate.dev',
      'https://admin.example.com/reset-password?token=invite-token-1',
      { locale: 'en' },
    );
    expect(invites.cooldowns.has(record.id)).toBe(true);
  });

  it('资料行缺失 404 admin.admin_not_found', async () => {
    const { app } = wire({ find: async () => null });
    const res = await app.request(`/v1/admins/${record.id}/resend-invite`, {
      method: 'POST',
      headers: json,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_not_found',
    );
  });

  it('已设密码(已激活) 409 admin.admin_invite_not_needed——链接唯一用途是设置初始密码', async () => {
    const sendInviteLink = vi.fn(async () => {});
    const { app, invites } = wire({
      sendInviteLink,
      passwordExists: () => [record.id],
    });
    const res = await app.request(`/v1/admins/${record.id}/resend-invite`, {
      method: 'POST',
      headers: json,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_invite_not_needed',
    );
    expect(sendInviteLink).not.toHaveBeenCalled();
    expect(invites.cooldowns.has(record.id)).toBe(false);
  });

  it('封禁管理员 403 admin.account_unavailable(不给封禁者发激活邮件)', async () => {
    const sendInviteLink = vi.fn(async () => {});
    const { app } = wire({
      sendInviteLink,
      find: async () => ({ ...record, status: 1 }),
    });
    const res = await app.request(`/v1/admins/${record.id}/resend-invite`, {
      method: 'POST',
      headers: json,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'admin.account_unavailable',
    );
    expect(sendInviteLink).not.toHaveBeenCalled();
  });

  it('SMTP 未配置/基地缺失 503 admin.admin_invite_link_unavailable(显式失败不哑成功)', async () => {
    const sendInviteLink = vi.fn(async () => {});
    const smtpDown = wire({ sendInviteLink, mailerConfigured: () => false });
    const res = await smtpDown.app.request(`/v1/admins/${record.id}/resend-invite`, {
      method: 'POST',
      headers: json,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_invite_link_unavailable',
    );

    const noBase = wire({ sendInviteLink, inviteLinkBase: null });
    const res2 = await noBase.app.request(`/v1/admins/${record.id}/resend-invite`, {
      method: 'POST',
      headers: json,
    });
    expect(res2.status).toBe(503);
    expect(sendInviteLink).not.toHaveBeenCalled();
  });

  it('冷却窗口内 429 admin.admin_invite_rate_limited(retry-after 60)', async () => {
    const sendInviteLink = vi.fn(async () => {});
    const { app } = wire({ sendInviteLink });
    const first = await app.request(`/v1/admins/${record.id}/resend-invite`, {
      method: 'POST',
      headers: json,
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/v1/admins/${record.id}/resend-invite`, {
      method: 'POST',
      headers: json,
    });
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_invite_rate_limited',
    );
    expect(sendInviteLink).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /v1/admins/:id', () => {
  it('改角色/封禁透传(update 收窄补丁);未命中 404 admin.admin_not_found', async () => {
    const { app, spies } = wire({ update: async () => ({ ...record, roleId: 5, status: 1 }) });
    const res = await app.request(`/v1/admins/${record.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ roleId: 5, status: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ roleId: 5, status: 1 });
    expect(spies.update).toHaveBeenCalledWith({
      adminId: record.id,
      roleId: 5,
      status: 1,
    });

    const missApp = wire({ update: async () => null }).app;
    const missing = await missApp.request('/v1/admins/999', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ roleId: 5 }),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_not_found',
    );
  });

  it('空补丁 400;status 词表外 400', async () => {
    const { app } = wire();
    const empty = await app.request(`/v1/admins/${record.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const badStatus = await app.request(`/v1/admins/${record.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 7 }),
    });
    expect(badStatus.status).toBe(400);
  });

  it('自改守卫（D6）:改自身 role/status 400 cannot_modify_self;displayName 可改自身', async () => {
    const { app, spies } = wire();
    const self = await app.request(`/v1/admins/${ADMIN_ID}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ roleId: 5 }),
    });
    expect(self.status).toBe(400);
    expect(((await self.json()) as { error: { code: string } }).error.code).toBe(
      'admin.cannot_modify_self',
    );
    expect(spies.update).not.toHaveBeenCalled();

    const selfBan = await app.request(`/v1/admins/${ADMIN_ID}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 1 }),
    });
    expect(selfBan.status).toBe(400);

    const selfName = await app.request(`/v1/admins/${ADMIN_ID}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ displayName: 'Me' }),
    });
    expect(selfName.status).toBe(200);
    expect(spies.update).toHaveBeenCalledWith({ adminId: ADMIN_ID, displayName: 'Me' });
  });
});
