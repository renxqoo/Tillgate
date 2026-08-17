/** 会话吊销锚点：无锚点全有效/线前失效线后有效/单调不后退/iat 双形态 */
import { describe, expect, it } from 'vitest';
import { InvalidUserIdError } from '../errors';
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
});
