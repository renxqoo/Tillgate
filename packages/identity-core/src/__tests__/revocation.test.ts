/** 会话吊销锚点：无锚点全有效/线前失效线后有效/单调不后退/iat 双形态 */
import { describe, expect, it } from 'vitest';
import { InvalidInputError, InvalidUserIdError } from '../errors';
import { buildFixture, nextUserId } from './helpers';

describe('revokeSessions / sessionValidAt', () => {
  it('无锚点 → 任意 iat 有效；吊销后线前失效、线上及线后有效', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const t0 = Date.now();
    expect(await identity.sessionValidAt({ userId, iat: t0 })).toBe(true);

    const anchor = new Date(t0 + 1_000);
    const { invalidBefore } = await identity.revokeSessions({ userId, at: anchor });
    expect(new Date(invalidBefore).getTime()).toBe(anchor.getTime());
    expect(await identity.sessionValidAt({ userId, iat: t0 })).toBe(false);
    expect(await identity.sessionValidAt({ userId, iat: anchor.getTime() })).toBe(true);
    expect(await identity.sessionValidAt({ userId, iat: anchor.getTime() + 1 })).toBe(true);
  });

  it('iat 接受 Date 与毫秒数；非法值 → InvalidInputError（单位歧义是 P0 温床，入口钉死）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const at = new Date();
    expect(await identity.sessionValidAt({ userId, iat: at })).toBe(true);
    expect(await identity.sessionValidAt({ userId, iat: at.getTime() })).toBe(true);
    await expect(identity.sessionValidAt({ userId, iat: Number.NaN })).rejects.toThrow();
    await expect(identity.revokeSessions({ userId: 0 as never })).rejects.toThrow(InvalidUserIdError);
  });

  it('单调：先吊销到 T2，再「回填」T1<T2 → 锚点保持 T2（管理回填不放松安全线）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const t1 = new Date(Date.now() - 3_600_000);
    const t2 = new Date();
    await identity.revokeSessions({ userId, at: t2 });
    const second = await identity.revokeSessions({ userId, at: t1 });
    expect(new Date(second.invalidBefore).getTime()).toBe(t2.getTime());
    expect(await identity.sessionValidAt({ userId, iat: t1.getTime() + 1 })).toBe(false);
  });

  it('改密/重置密码隐式推进锚点（跨域联动：passwords 动词内部调用）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const staleIat = Date.now() - 60_000;
    expect(await identity.sessionValidAt({ userId, iat: staleIat })).toBe(true);
    await identity.resetPassword({ userId, newPassword: 'fresh-password-1' });
    expect(await identity.sessionValidAt({ userId, iat: staleIat })).toBe(false);
  });

  it('realm 隔离：同 numeric id 的 user/admin 锚点互不相干（双身份不串号）', async () => {
    const { identity } = buildFixture({ realms: ['user', 'admin'] });
    const id = nextUserId(); // user.id 与 admin.id 可能同值——realm 是唯一隔离维度
    const t0 = Date.now();
    // user 域吊销 → user 域线前失效，admin 域不受影响
    await identity.revokeSessions({ userId: id, realm: 'user', at: new Date(t0 + 1_000) });
    expect(await identity.sessionValidAt({ userId: id, realm: 'user', iat: t0 })).toBe(false);
    expect(await identity.sessionValidAt({ userId: id, realm: 'admin', iat: t0 })).toBe(true);
    // admin 域吊销到更晚 → 两域各自单调，互不覆盖
    const t1 = t0 + 60_000;
    await identity.revokeSessions({ userId: id, realm: 'admin', at: new Date(t1) });
    expect(await identity.sessionValidAt({ userId: id, realm: 'admin', iat: t1 - 1 })).toBe(false);
    expect(await identity.sessionValidAt({ userId: id, realm: 'user', iat: t0 + 2_000 })).toBe(true);
  });

  it('未声明的 realm → 拒绝（fail-closed）；缺省 realm=user 无需声明', async () => {
    const { identity } = buildFixture(); // 默认 realms=['user']
    const userId = nextUserId();
    await expect(identity.revokeSessions({ userId, realm: 'admin' })).rejects.toThrow(
      InvalidInputError,
    );
    await expect(identity.sessionValidAt({ userId, realm: 'Bad_Realm', iat: Date.now() })).rejects.toThrow(
      InvalidInputError,
    );
    await expect(
      identity.revokeSessions({ userId, realm: 'admin', at: new Date() } as never),
    ).rejects.toThrow(/unknown realm 'admin'/);
    // 缺省 realm 走 user 域，正常工作
    const { invalidBefore } = await identity.revokeSessions({ userId });
    expect(typeof invalidBefore).toBe('string');
  });
});
