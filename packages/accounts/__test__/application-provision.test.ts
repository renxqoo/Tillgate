/**
 * 建号用例行为规格(MIGRATION §1.1-1/2):
 * 本地建号(规范化/兜底显示名/占用冲突)、OAuth find-or-create 幂等与竞态回查。
 */
import { describe, expect, it } from 'vitest';
import { AccountsErrors } from '../src/domain/errors.js';
import { createTestHarness } from '../src/testing/harness.js';

describe('provisionLocalAccount', () => {
  it('issuer=local、subject=规范化 email、displayName 兜底 email 本地部分', async () => {
    const h = createTestHarness();
    const user = await h.api.provisionLocalAccount({ email: '  Alice@Example.IO ' });
    expect(user.issuer).toBe('local');
    expect(user.identityProvider).toBe('local');
    expect(user.subject).toBe('alice@example.io');
    expect(user.email).toBe('alice@example.io');
    expect(user.displayName).toBe('alice');
    expect(user.status).toBe(0);
  });

  it('email 形状不合法 → email_invalid', async () => {
    const h = createTestHarness();
    await expect(h.api.provisionLocalAccount({ email: 'not-an-email' })).rejects.toMatchObject({
      code: 'accounts.email_invalid',
    });
  });

  it('重复邮箱(含大小写归一)→ email_taken(唯一索引语义)', async () => {
    const h = createTestHarness();
    await h.api.provisionLocalAccount({ email: 'a@x.io' });
    await expect(h.api.provisionLocalAccount({ email: 'A@X.IO' })).rejects.toMatchObject({
      code: 'accounts.email_taken',
    });
  });

  it('显式 displayName 校验 1..64;超长拒绝', async () => {
    const h = createTestHarness();
    await expect(
      h.api.provisionLocalAccount({ email: 'a@x.io', displayName: 'x'.repeat(65) }),
    ).rejects.toMatchObject({ code: 'accounts.display_name_invalid' });
    const u = await h.api.provisionLocalAccount({ email: 'b@x.io', displayName: 'Bee' });
    expect(u.displayName).toBe('Bee');
  });

  it('不触碰认证秘密列(G5:password_hash 不在用例面)', async () => {
    const h = createTestHarness();
    const user = await h.api.provisionLocalAccount({ email: 'a@x.io' });
    expect('passwordHash' in user).toBe(false);
  });
});

describe('provisionOAuthAccount(find-or-create)', () => {
  it('首次创建:identityProvider=issuer 截 16、显示名兜底', async () => {
    const h = createTestHarness();
    const { user, created } = await h.api.provisionOAuthAccount({
      issuer: 'github',
      subject: '12345678',
      email: 'dev@gh.io',
    });
    expect(created).toBe(true);
    expect(user.identityProvider).toBe('github');
    expect(user.displayName).toBe('用户123456');
    const again = await h.api.provisionOAuthAccount({ issuer: 'github', subject: '12345678' });
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(user.id);
  });

  it('显式 displayName 优先(截 64);畸形 email 按无邮箱落库', async () => {
    const h = createTestHarness();
    const { user } = await h.api.provisionOAuthAccount({
      issuer: 'google',
      subject: 'sub-1',
      email: 'not valid',
      displayName: '  开发者  ',
    });
    expect(user.displayName).toBe('开发者');
    expect(user.email).toBeNull();
  });

  it('同 issuer 不同 subject 是两个账号', async () => {
    const h = createTestHarness();
    const a = await h.api.provisionOAuthAccount({ issuer: 'github', subject: 'u1' });
    const b = await h.api.provisionOAuthAccount({ issuer: 'github', subject: 'u2' });
    expect(a.user.id).not.toBe(b.user.id);
  });

  it('错误码类型核对(目录实例)', async () => {
    const e = AccountsErrors.business('email_invalid');
    expect(e.category).toBe('invalid_input');
  });
});
