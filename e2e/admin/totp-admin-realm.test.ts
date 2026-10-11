/**
 * admin realm 身份写入回归 e2e（迁移 0112/0113 事故的旅程锁）。
 *
 * 事故：0112 给 identity 七表加 user_id → users.id 外键并清理「孤儿」——
 * 但 user_id 是 user/admin 双 realm 共用的扁平主键，管理员 id（≥1e9 段）
 * 按设计不在 users 表。后果两连：存量管理员凭据/密码/TOTP 行被当孤儿删除
 * （全部管理员 Invalid credentials 登不上）；此后一切管理员身份写入
 * （TOTP 绑定/确认、邀请设密、2FA 发码、锚点）23503 → 前端「引用的资源不存在」。
 *
 * 本旅程用真实 1e9 段管理员 id 走完整身份链（真实 PG + 真 FK 状态），
 * 0112 形态下 enroll 即红；0113 撤 FK 后全绿。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  admins,
  identityCredentials,
  identityPasswords,
  identityRecoveryCodes,
  identitySessionAnchors,
  identityTotp,
  roles as rolesTable,
} from '@tillgate/db';
import { base32Decode, matchingTotpStep, totpAt } from '../../packages/identity/src/domain/totp.js';
import { jsonHeaders, setupE2EAdmin, teardownE2EAdmin, type E2EAdminWorld } from './kit';

let world: E2EAdminWorld | null = null;

/** 旅程专属管理员（真实 1e9 段 id——admin-store 分配段;清理面） */
const journeyAdminIds: number[] = [];

beforeAll(async () => {
  world = await setupE2EAdmin();
}, 60_000);

afterAll(async () => {
  if (world === null) return;
  if (journeyAdminIds.length > 0) {
    // 0113 后 identity 表无 FK——身份行按写入面逐表删净（含 confirm 重签的恢复码与
    // reset 推进的 admin 锚点），不留跨旅程孤儿行
    await world.assembly.db
      .delete(identityRecoveryCodes)
      .where(inArray(identityRecoveryCodes.userId, journeyAdminIds));
    await world.assembly.db
      .delete(identitySessionAnchors)
      .where(
        and(
          eq(identitySessionAnchors.realm, 'admin'),
          inArray(identitySessionAnchors.userId, journeyAdminIds),
        ),
      );
    await world.assembly.db
      .delete(identityTotp)
      .where(inArray(identityTotp.userId, journeyAdminIds));
    await world.assembly.db
      .delete(identityPasswords)
      .where(inArray(identityPasswords.userId, journeyAdminIds));
    await world.assembly.db
      .delete(identityCredentials)
      .where(inArray(identityCredentials.userId, journeyAdminIds));
    await world.assembly.db.delete(admins).where(inArray(admins.id, journeyAdminIds));
  }
  await teardownE2EAdmin(world);
});

function w(): E2EAdminWorld {
  if (world === null) throw new Error('e2e world not ready');
  return world;
}

/** 指定令牌的 HTTP 调用（旅程管理员各自持令牌——kit.call 固定用 world.token 不适用） */
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

/** 建真实管理员行（1e9 段 id——与生产 create-admin 同段）并签发真会话令牌 */
async function journeyAdmin(): Promise<{ id: number; token: string; email: string }> {
  const email = `e2e-totp-${Date.now()}-${journeyAdminIds.length}@e2e.invalid`;
  const [roleRow] = await w()
    .assembly.db.select({ id: rolesTable.id })
    .from(rolesTable)
    .where(eq(rolesTable.code, 'super_admin'));
  if (roleRow == null) throw new Error('role super_admin missing (run migrations 0082)');
  // 经 control-plane admins.create（与生产 POST /v1/admins 同路径——id 落 ≥1e9 段
  // 是 admin-store 的段分配语义,直插表会绕过它拿到小 id）
  const created = await w().assembly.controlPlane.admins.create({
    email,
    roleId: roleRow.id,
    displayName: 'e2e-totp-admin-realm',
  });
  journeyAdminIds.push(created.id);
  const token = await w().assembly.identity.sessions.sign({
    realm: 'admin',
    subjectId: created.id,
    ttlSec: 600,
  });
  return { id: created.id, token, email };
}

/** enroll 返回的 base32 secret → 当前有效 6 位码（真时钟;窗口内命中步号重取同码） */
function currentCode(secretBase32: string): string {
  const secret = base32Decode(secretBase32);
  const epochMs = Date.now();
  const matched = matchingTotpStep(secret, totpAt(secret, epochMs, 30), epochMs, 30, 1);
  return totpAt(secret, matched != null ? matched * 30_000 : epochMs, 30);
}

/** 下一窗口步的码（confirm 已消费当前步——防重放单调 CAS,二次验证须新步） */
function nextCode(secretBase32: string): string {
  const secret = base32Decode(secretBase32);
  const step = Math.floor(Date.now() / 1000 / 30) + 1;
  return totpAt(secret, step * 30_000, 30);
}

describe('H. admin realm 身份写入（迁移 0112 回归——管理员 id 不在 users 表）', () => {
  it('管理员 id 落 1e9 段且无 users 影子行（架构前提自检）', async () => {
    const admin = await journeyAdmin();
    expect(admin.id).toBeGreaterThanOrEqual(1_000_000_000);
    const { sql } = await import('drizzle-orm');
    const shadow = await w().assembly.db.execute(sql`select id from users where id = ${admin.id}`);
    const rows =
      (shadow as unknown as { rows?: unknown[] }).rows ?? (shadow as unknown as unknown[]);
    expect((rows as unknown[]).length).toBe(0);
  });

  it('TOTP 绑定全链：enroll 出密钥 → confirm 生效 → me.totpEnabled → step-up 验码放行（0112 形态下 enroll 即 23503）', async () => {
    const admin = await journeyAdmin();

    const enrolled = await callAs(admin.token, '/v1/me/totp/enroll', { method: 'POST' });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
    const secret = enrolled.body.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    const confirmed = await callAs(admin.token, '/v1/me/totp/confirm', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ code: currentCode(secret) }),
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(Array.isArray(confirmed.body.recoveryCodes)).toBe(true);

    // 绑定后 me 面投影 totpEnabled（绑定即接管第二因子）
    const me = await callAs(admin.token, '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.totpEnabled).toBe(true);

    // step-up（敏感设置写入的前置验码）：下一窗口步对码放行 = 无抛出（confirm 已
    // 消费当前步——防重放单调 CAS;此处锁 confirm 后验证面同链路完好）
    await expect(
      w().assembly.identity.mfa.verifyTotpOnly({ userId: admin.id, code: nextCode(secret) }),
    ).resolves.toBeUndefined();
  });

  it('管理员凭据+密码写入：register 凭据 → reset 密码 → authenticate 命中（0112 形态下两写均 23503）', async () => {
    const admin = await journeyAdmin();
    await w().assembly.identity.credentials.register({
      userId: admin.id,
      identifier: { kind: 'email', value: admin.email },
    });
    await w().assembly.identity.passwords.reset({
      userId: admin.id,
      realm: 'admin',
      newPassword: 'e2e-totp-realm-pass-1',
    });
    const authed = await w().assembly.identity.passwords.authenticate({
      identifier: { kind: 'email', value: admin.email },
      password: 'e2e-totp-realm-pass-1',
    });
    expect(authed.userId).toBe(admin.id);
  });
});
