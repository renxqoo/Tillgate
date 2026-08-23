/**
 * OAuth 用例测试(v1 oauth.test + oauth.service 语义迁移):绑定/幂等/冲突分类、
 * 最后凭据守卫、state 签发消费、provider 未配置、上游 profile 映射(B27)。
 */
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '../src/testing/harness.js';

const harness = () => createTestHarness();

describe('oauth.link / unlink / findUser', () => {
  it('绑定可寻址 + 同人同 provider 同 subject 幂等重放', async () => {
    const h = harness();
    const first = await h.api.oauth.link({
      userId: 1,
      provider: 'github',
      subject: 'gh-1',
      email: 'A@Example.com',
    });
    expect(first.replayed).toBe(false);
    const replay = await h.api.oauth.link({ userId: 1, provider: 'github', subject: 'gh-1' });
    expect(replay).toEqual({ linkId: first.linkId, replayed: true });
    expect(await h.api.oauth.findUser({ provider: 'github', subject: 'gh-1' })).toBe(1);
    expect(await h.api.oauth.findUser({ provider: 'github', subject: 'gh-x' })).toBeNull();
  });

  it('(provider,subject) 第二用户 → provider_identity_taken;同用户第二账号 → user_already_linked', async () => {
    const h = harness();
    await h.api.oauth.link({ userId: 1, provider: 'github', subject: 'gh-2' });
    await expect(
      h.api.oauth.link({ userId: 2, provider: 'github', subject: 'gh-2' }),
    ).rejects.toMatchObject({
      code: 'identity.provider_already_linked',
      context: { conflict: 'provider_identity_taken' },
    });
    await expect(
      h.api.oauth.link({ userId: 1, provider: 'github', subject: 'gh-3' }),
    ).rejects.toMatchObject({
      code: 'identity.provider_already_linked',
      context: { conflict: 'user_already_linked' },
    });
  });

  it('不同 provider 并存;email 仅展示归一', async () => {
    const h = harness();
    await h.api.oauth.link({
      userId: 1,
      provider: 'github',
      subject: 'gh',
      email: 'A@Example.com',
    });
    await expect(
      h.api.oauth.link({ userId: 1, provider: 'google', subject: 'gg' }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it('唯一登录方式不可解绑 → last_credential;有密码兜底可解绑,二次解绑 NotFound', async () => {
    const h = harness();
    await h.api.oauth.link({ userId: 1, provider: 'github', subject: 'gh' });
    await expect(h.api.oauth.unlink({ userId: 1, provider: 'github' })).rejects.toMatchObject({
      code: 'identity.last_credential',
    });

    await h.api.credentials.register({
      userId: 1,
      identifier: { kind: 'email', value: 'oauth@example.com' },
      password: 'password-123456',
    });
    await expect(h.api.oauth.unlink({ userId: 1, provider: 'github' })).resolves.toEqual({
      unlinked: true,
      linkId: expect.any(Number),
    });
    expect(await h.api.oauth.findUser({ provider: 'github', subject: 'gh' })).toBeNull();
    await expect(h.api.oauth.unlink({ userId: 1, provider: 'github' })).rejects.toMatchObject({
      code: 'identity.oauth_link_not_found',
    });
  });

  it('第二 provider 兜底可解绑', async () => {
    const h = harness();
    await h.api.oauth.link({ userId: 1, provider: 'github', subject: 'gh' });
    await h.api.oauth.link({ userId: 1, provider: 'google', subject: 'gg' });
    await expect(h.api.oauth.unlink({ userId: 1, provider: 'github' })).resolves.toMatchObject({
      unlinked: true,
    });
  });

  it('词表外 provider 拒绝', async () => {
    const h = harness();
    await expect(
      h.api.oauth.link({ userId: 1, provider: 'gitlab', subject: 'gl' }),
    ).rejects.toMatchObject({ code: 'identity.unknown_provider' });
  });

  it('审计 targetId = linkId(B20)', async () => {
    const h = harness();
    const { linkId } = await h.api.oauth.link({ userId: 1, provider: 'github', subject: 'gh' });
    const event = h.audit.events.find((e) => e.action === 'oauth.link');
    expect(event?.targetId).toBe(linkId);
  });
});

describe('oauth.authorize / callback(state 半程)', () => {
  it('authorize:state 签发 + 授权 URL 形状;callback:单次消费 + next 往返', async () => {
    const h = harness();
    const { url, state } = await h.api.oauth.authorize({
      provider: 'github',
      redirectUri: 'https://api.example.com/v1/oauth/github/callback',
      next: '/dashboard',
    });
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    expect(url).toContain('https://github.com/login/oauth/authorize?');
    expect(url).toContain('scope=read%3Auser+user%3Aemail');
    expect(url).toContain(`state=${state}`);

    const google = await h.api.oauth.authorize({
      provider: 'google',
      redirectUri: 'https://api.example.com/v1/oauth/google/callback',
    });
    expect(google.url).toContain('response_type=code');

    // callback:code 为空 → invalid_input;state 单次消费
    const fakeProvider = {
      authorizeUrl: ({ redirectUri, state: s }: { redirectUri: string; state: string }) =>
        `https://idp.example.com/auth?redirect=${redirectUri}&state=${s}`,
      exchangeAndProfile: async () => ({
        subject: 'pl-1',
        email: 'user@idp.example.com',
        displayName: 'Custom IdP',
      }),
    };
    const { createIdentity } = await import('../src/identity.js');
    const { TEST_CONFIG } = await import('../src/testing/harness.js');
    const api = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => undefined },
      config: { ...TEST_CONFIG, providers: ['github', 'google', 'customidp'] },
      store: h.store,
      oauthStateStore: h.oauthState,
      oauthProviders: { customidp: fakeProvider },
    });
    const emptyCode = await api.oauth.authorize({
      provider: 'customidp',
      redirectUri: 'https://cb',
      next: '/x',
    });
    await expect(
      api.oauth.callback({
        provider: 'customidp',
        code: '',
        state: emptyCode.state,
        redirectUri: 'https://cb',
      }),
    ).rejects.toMatchObject({ code: 'identity.invalid_input' });
    const auth = await api.oauth.authorize({
      provider: 'customidp',
      redirectUri: 'https://cb',
      next: '/x',
    });
    const profile = await api.oauth.callback({
      provider: 'customidp',
      code: 'auth-code-1',
      state: auth.state,
      redirectUri: 'https://cb',
    });
    expect(profile).toMatchObject({ subject: 'pl-1', email: 'user@idp.example.com', next: '/x' });
    // state 单次:二次消费拒绝
    await expect(
      api.oauth.callback({
        provider: 'customidp',
        code: 'auth-code-1',
        state: auth.state,
        redirectUri: 'https://cb',
      }),
    ).rejects.toMatchObject({ code: 'identity.oauth_state_invalid' });
  });

  it('state provider 不匹配 → oauth_state_invalid;存储不可达 → unavailable(fail-closed)', async () => {
    const h = harness();
    const githubAuth = await h.api.oauth.authorize({
      provider: 'github',
      redirectUri: 'https://cb',
    });
    await expect(
      h.api.oauth.callback({
        provider: 'google',
        code: 'c',
        state: githubAuth.state,
        redirectUri: 'https://cb',
      }),
    ).rejects.toMatchObject({ code: 'identity.oauth_state_invalid' });

    h.oauthState.failWrites = true;
    await expect(
      h.api.oauth.authorize({ provider: 'github', redirectUri: 'https://cb' }),
    ).rejects.toMatchObject({
      code: 'identity.oauth_state_unavailable',
    });
  });

  it('provider 未配置凭据 → oauth_provider_unconfigured', async () => {
    const h = harness();
    const { createIdentity } = await import('../src/identity.js');
    const { TEST_CONFIG } = await import('../src/testing/harness.js');
    const api = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => undefined },
      config: {
        ...TEST_CONFIG,
        providers: ['github', 'gitlab'],
        oauth: { github: TEST_CONFIG.oauth.github! },
      },
      store: h.store,
      oauthStateStore: h.oauthState,
    });
    await expect(
      api.oauth.authorize({ provider: 'gitlab', redirectUri: 'https://cb' }),
    ).rejects.toMatchObject({
      code: 'identity.oauth_provider_unconfigured',
    });
  });

  it('上游交换失败 → oauth_profile_failed(不吞细节)', async () => {
    const h = harness();
    const { createIdentity } = await import('../src/identity.js');
    const { TEST_CONFIG } = await import('../src/testing/harness.js');
    const api = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => undefined },
      config: TEST_CONFIG,
      store: h.store,
      oauthStateStore: h.oauthState,
      oauthProviders: {
        github: {
          authorizeUrl: () => 'https://x',
          exchangeAndProfile: async () => {
            throw new Error('token exchange failed: 502');
          },
        },
      },
    });
    const auth = await api.oauth.authorize({ provider: 'github', redirectUri: 'https://cb' });
    await expect(
      api.oauth.callback({
        provider: 'github',
        code: 'c',
        state: auth.state,
        redirectUri: 'https://cb',
      }),
    ).rejects.toMatchObject({
      code: 'identity.oauth_profile_failed',
      context: { detail: 'token exchange failed: 502' },
    });
  });
});
