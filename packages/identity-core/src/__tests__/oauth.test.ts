/** OAuth 绑定：防劫持唯一性/幂等重放/双面冲突分类/凭据集守卫/事务注入 */
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../password';
import {
  LastCredentialError,
  OAuthLinkNotFoundError,
  ProviderAlreadyLinkedError,
  UnknownProviderError,
} from '../errors';
import { buildFixture, db, nextEmail, nextUserId } from './helpers';

describe('findOAuthUser / linkOAuth', () => {
  it('绑定后可寻址；同人同 provider 同 subject 重绑 → 幂等重放', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    const first = await identity.linkOAuth({ userId, provider: 'github', subject: 'octo-1', email: 'OCTO@Example.com' });
    expect(first.replayed).toBe(false);
    expect(await identity.findOAuthUser({ provider: 'github', subject: 'octo-1' })).toBe(userId);
    const replay = await identity.linkOAuth({ userId, provider: 'github', subject: 'octo-1' });
    expect(replay).toEqual({ linkId: first.linkId, replayed: true });
  });

  it('防劫持：同 (provider, subject) 第二个用户 → provider_identity_taken', async () => {
    const { identity } = buildFixture();
    await identity.linkOAuth({ userId: nextUserId(), provider: 'github', subject: 'shared-1' });
    const error = await identity
      .linkOAuth({ userId: nextUserId(), provider: 'github', subject: 'shared-1' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as ProviderAlreadyLinkedError,
      );
    expect(error).toBeInstanceOf(ProviderAlreadyLinkedError);
    expect(error.conflict).toBe('provider_identity_taken');
  });

  it('一人一 provider：同用户绑第二个 github 账号 → user_already_linked', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.linkOAuth({ userId, provider: 'github', subject: 'first-1' });
    const error = await identity
      .linkOAuth({ userId, provider: 'github', subject: 'second-2' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as ProviderAlreadyLinkedError,
      );
    expect(error).toBeInstanceOf(ProviderAlreadyLinkedError);
    expect(error.conflict).toBe('user_already_linked');
  });

  it('同用户不同 provider 可并存；email 只做展示（大小写归一）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.linkOAuth({ userId, provider: 'github', subject: 'gh-1' });
    await identity.linkOAuth({ userId, provider: 'google', subject: 'go-1', email: 'A@B.CO' });
    expect(await identity.findOAuthUser({ provider: 'google', subject: 'go-1' })).toBe(userId);
  });

  it('并发绑同一 (provider, subject)：恰好一人成功（唯一索引兜底）', async () => {
    const { identity } = buildFixture();
    for (let round = 0; round < 3; round += 1) {
      const subject = `race-${round}-${Date.now()}`;
      const outcomes = await Promise.allSettled([
        identity.linkOAuth({ userId: nextUserId(), provider: 'github', subject }),
        identity.linkOAuth({ userId: nextUserId(), provider: 'github', subject }),
      ]);
      const ok = outcomes.filter((o) => o.status === 'fulfilled');
      const conflict = outcomes.filter(
        (o) => o.status === 'rejected' && o.reason instanceof ProviderAlreadyLinkedError,
      );
      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(1);
    }
  });

  it('白名单外 provider → UnknownProviderError', async () => {
    const { identity } = buildFixture();
    await expect(
      identity.linkOAuth({ userId: nextUserId(), provider: 'facebook', subject: 'fb-1' }),
    ).rejects.toThrow(UnknownProviderError);
  });

  it('事务注入：随调用方事务回滚', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await expect(
      db.transaction(async (tx) => {
        await identity.linkOAuth({ tx, userId, provider: 'github', subject: 'rollback-1' });
        throw new Error('caller-abort');
      }),
    ).rejects.toThrow('caller-abort');
    expect(await identity.findOAuthUser({ provider: 'github', subject: 'rollback-1' })).toBeNull();
  });
});

describe('unlinkOAuth（凭据集守卫）', () => {
  it('唯一登录方式不可解绑 → LastCredentialError', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.linkOAuth({ userId, provider: 'github', subject: 'only-1' });
    await expect(identity.unlinkOAuth({ userId, provider: 'github' })).rejects.toThrow(LastCredentialError);
    expect(await identity.findOAuthUser({ provider: 'github', subject: 'only-1' })).toBe(userId);
  });

  it('有密码兜底 → 可解绑；解绑后寻址为 null', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.linkOAuth({ userId, provider: 'github', subject: 'pw-backed-1' });
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: nextEmail() },
      passwordHash: await hashPassword('backup-password-1'),
    });
    expect(await identity.unlinkOAuth({ userId, provider: 'github' })).toEqual({ unlinked: true });
    expect(await identity.findOAuthUser({ provider: 'github', subject: 'pw-backed-1' })).toBeNull();
    await expect(identity.unlinkOAuth({ userId, provider: 'github' })).rejects.toThrow(OAuthLinkNotFoundError);
  });

  it('有第二个 provider 兜底 → 可解绑', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.linkOAuth({ userId, provider: 'github', subject: 'gh-a' });
    await identity.linkOAuth({ userId, provider: 'google', subject: 'go-a' });
    expect(await identity.unlinkOAuth({ userId, provider: 'github' })).toEqual({ unlinked: true });
    expect(await identity.findOAuthUser({ provider: 'google', subject: 'go-a' })).toBe(userId);
  });

  it('并发解绑最后一个方式（有密码）：一人成功一人 NotFound（行已删）', async () => {
    const { identity } = buildFixture();
    const userId = nextUserId();
    await identity.linkOAuth({ userId, provider: 'github', subject: 'concurrent-unlink' });
    await identity.registerCredential({
      userId,
      identifier: { kind: 'email', value: nextEmail() },
      passwordHash: await hashPassword('backup-password-2'),
    });
    const outcomes = await Promise.allSettled([
      identity.unlinkOAuth({ userId, provider: 'github' }),
      identity.unlinkOAuth({ userId, provider: 'github' }),
    ]);
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(await identity.findOAuthUser({ provider: 'github', subject: 'concurrent-unlink' })).toBeNull();
  });
});
