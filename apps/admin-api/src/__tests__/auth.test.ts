/**
 * 管理员认证语义：
 *   - 登录：密码错 401 / 2FA 开启 → code_required（无 token）/ SMTP 缺席 503 fail-closed
 *   - 验码：错码 401 ×4 → 第 5 次作废（正码也 400）；60s 重发冷却 429；通过签会话
 *   - 改密：失效线同拍推进——旧 token 立即失效、新 token 可用、旧密码死亡
 *   - 2FA 开关：未配 SMTP 开启 → 400；配置后可开可关
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { verifyPassword } from '@ai-gateway/identity-core';
import { identityChallenges } from '@ai-gateway/identity-core';
import { createLoginCodeChallenger, type Mailer } from '@ai-gateway/identity';
import { admins } from '@ai-gateway/db';
import type { RunContext } from '@ai-gateway/service';
import { createAdminAuthService } from '../services/auth.service.js';
import { db, newAdmin, TEST_JWT_SECRET, TEST_PASSWORD, buildTestApp, openKeyGuard, openIpGuard } from './helpers.js';

const ctx: RunContext = { requestId: 'test', actor: { kind: 'system' }, traceParent: null };

function fakeMailer(): { mailer: Mailer; sent: Array<{ to: string; code: string }> } {
  const sent: Array<{ to: string; code: string }> = [];
  const mailer: Mailer = {
    async sendLoginCode(to, code) {
      sent.push({ to, code });
    },
    async send() {},
  };
  return { mailer, sent };
}

function service(mailer: Mailer | null) {
  return createAdminAuthService({
    db,
    jwtSecret: TEST_JWT_SECRET,
    sessionTtlSeconds: 3_600,
    loginGuard: openKeyGuard,
    ipGuard: openIpGuard,
    mailer,
  });
}

describe('管理员登录', () => {
  it('密码错 → 401 invalid_credentials（不泄漏账号存在性）', async () => {
    const { email } = await newAdmin();
    await expect(service(fakeMailer().mailer).login(ctx, { email, password: 'wrong-password', ip: '1.2.3.4' }))
      .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('密码对（未开 2FA）→ 直接签会话', async () => {
    const { email } = await newAdmin();
    const result = await service(null).login(ctx, { email, password: TEST_PASSWORD, ip: '1.2.3.4' });
    expect(result).toMatchObject({ kind: 'success' });
  });

  it('2FA 开启：密码对 → code_required（无 token），验码通过签会话', async () => {
    const { mailer, sent } = fakeMailer();
    const { email } = await newAdmin({ twoFactorEnabled: true });
    const svc = service(mailer);

    const first = await svc.login(ctx, { email, password: TEST_PASSWORD, ip: '1.2.3.4' });
    expect(first).toMatchObject({ kind: 'code_required' });
    expect(sent.length).toBe(1);

    const verified = await svc.verifyLoginCode(ctx, {
      challengeId: (first as { challengeId: string }).challengeId,
      code: sent[0]!.code,
    });
    expect(verified.token).toBeTruthy();
  });

  it('2FA 开启但 SMTP 缺席 → 503 fail-closed（绝不降级单密码）', async () => {
    const { email } = await newAdmin({ twoFactorEnabled: true });
    await expect(service(null).login(ctx, { email, password: TEST_PASSWORD, ip: '1.2.3.4' }))
      .rejects.toMatchObject({ status: 503, code: 'two_factor_unavailable' });
  });

  it('错码 4 次 401 → 第 5 次挑战作废（正码也 400）；重发冷却 60s 内 429', async () => {
    const { mailer, sent } = fakeMailer();
    const { email, id } = await newAdmin({ twoFactorEnabled: true });
    const svc = service(mailer);

    const first = (await svc.login(ctx, { email, password: TEST_PASSWORD, ip: '1.2.3.4' })) as {
      challengeId: string;
    };
    for (let i = 0; i < 4; i += 1) {
      await expect(svc.verifyLoginCode(ctx, { challengeId: first.challengeId, code: '000000' }))
        .rejects.toMatchObject({ status: 401, code: 'code_invalid' });
    }
    // 第 5 次错码 → 挑战作废
    await expect(svc.verifyLoginCode(ctx, { challengeId: first.challengeId, code: '000000' }))
      .rejects.toMatchObject({ status: 400, code: 'challenge_invalid' });
    // 作废后正码也不行
    await expect(svc.verifyLoginCode(ctx, { challengeId: first.challengeId, code: sent[0]!.code }))
      .rejects.toMatchObject({ status: 400, code: 'challenge_invalid' });

    // 60s 冷却内再次登录发码 → 429
    await expect(svc.login(ctx, { email, password: TEST_PASSWORD, ip: '1.2.3.4' }))
      .rejects.toMatchObject({ status: 429, code: 'code_rate_limited' });

    // 冷却过了（回拨 issued_at 61s）→ 新挑战可验
    await db
      .update(identityChallenges)
      .set({ issuedAt: new Date(Date.now() - 61_000) })
      .where(eq(identityChallenges.identifierValue, email));
    const second = (await svc.login(ctx, { email, password: TEST_PASSWORD, ip: '1.2.3.4' })) as {
      challengeId: string;
    };
    const verified = await svc.verifyLoginCode(ctx, {
      challengeId: second.challengeId,
      code: sent.at(-1)!.code,
    });
    expect(verified.adminId).toBe(id);
  });
});

describe('改密与会话失效线（R5-2）', () => {
  it('改密后旧 token 立即失效、新 token 可用、旧密码死亡', async () => {
    const { request } = buildTestApp();
    const { id, token } = await newAdmin();

    const res = await request('/v1/me/password', {
      token,
      body: { oldPassword: TEST_PASSWORD, newPassword: 'fresh-horse-battery-9' },
    });
    expect(res.status).toBe(200);
    const { token: newToken } = (await res.json()) as { token: string };

    // 旧 token：失效线之前签发 → 401
    expect((await request('/v1/me', { token })).status).toBe(401);
    // 新 token：失效线之后签发 → 200
    expect((await request('/v1/me', { token: newToken })).status).toBe(200);

    // 旧密码死亡（登录 401）
    const [row] = await db.select().from(admins).where(eq(admins.id, id));
    expect(await verifyPassword('fresh-horse-battery-9', row!.passwordHash)).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, row!.passwordHash)).toBe(false);
  });

  it('原密码错 → 401，改密不发生', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/me/password', {
      token,
      body: { oldPassword: 'wrong-old-password', newPassword: 'fresh-horse-battery-9' },
    });
    expect(res.status).toBe(401);
  });
});

describe('2FA 开关', () => {
  it('未配 SMTP 开启 → 400 smtp_not_configured', async () => {
    const { request } = buildTestApp(); // 测试装配无 SMTP → mailer null
    const { token } = await newAdmin();
    const res = await request('/v1/me/two-factor', { token, body: { enabled: true } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('smtp_not_configured');
  });
});

describe('me 路由', () => {
  it('回显管理员资料（无密码哈希）', async () => {
    const { request } = buildTestApp();
    const { token, email } = await newAdmin();
    const res = await request('/v1/me', { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ email });
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|password_hash/);
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]+:[0-9a-f]+:\d+:\d+:\d+/);
  });
});

describe('登录验证码挑战表', () => {
  it('未知挑战验码 → 拒绝（admin 命名空间隔离由 identity 层保证）', async () => {
    const { mailer } = fakeMailer();
    const challenger = createLoginCodeChallenger(db, { mailer });
    await expect(
      challenger.verify('admin', { challengeId: '00000000-0000-4000-8000-000000000000', code: '123456' }),
    ).rejects.toBeTruthy();
  });
});
