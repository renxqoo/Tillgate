import { describe, expect, it, vi } from 'vitest';

import { captchaFromEnv, createTurnstileCaptcha } from '../captcha.js';

/**
 * Turnstile 人机验证组件（注册面防刷）：
 *   - success → ok；客户端过错码（invalid-input-response / timeout-or-duplicate /
 *     missing-input-response）→ invalid（400 语义）
 *   - 配置/服务端过错码（missing-input-secret / invalid-input-secret / bad-request）
 *     → unavailable（503 语义，fail-closed 不放行）
 *   - 网络失败/超时/非 200/非 JSON → unavailable（绝不因厂商故障放行）
 *   - 空 token 本地拒绝，不发网络请求
 *   - captchaFromEnv：成对配置才启用；只配一半 → 抛错（fail fast，安全控制不许静默半开）
 */

const VERIFY_URL = 'https://turnstile.test/siteverify';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function service(fetchImpl: typeof fetch) {
  return createTurnstileCaptcha({
    siteKey: 'site-key',
    secretKey: 'secret-key',
    verifyUrl: VERIFY_URL,
    fetchImpl,
  });
}

describe('createTurnstileCaptcha.verify', () => {
  it('success → ok，请求按表单编码携带 secret/response/remoteip', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    const captcha = service(fetchImpl as unknown as typeof fetch);

    await expect(captcha.verify({ token: 'tok', remoteIp: '203.0.113.10' })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(VERIFY_URL);
    expect(init.method).toBe('POST');
    const body = init.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body.get('secret')).toBe('secret-key');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('203.0.113.10');
  });

  it.each(['invalid-input-response', 'timeout-or-duplicate', 'missing-input-response', 'invalid-or-already-seen-response'])(
    '客户端过错码 %s → invalid',
    async (code) => {
      const captcha = service(
        vi.fn(async () => jsonResponse({ success: false, 'error-codes': [code] })) as unknown as typeof fetch,
      );
      await expect(captcha.verify({ token: 'tok' })).rejects.toMatchObject({ reason: 'invalid' });
    },
  );

  it.each(['missing-input-secret', 'invalid-input-secret', 'bad-request'])(
    '配置/服务端过错码 %s → unavailable',
    async (code) => {
      const captcha = service(
        vi.fn(async () => jsonResponse({ success: false, 'error-codes': [code] })) as unknown as typeof fetch,
      );
      await expect(captcha.verify({ token: 'tok' })).rejects.toMatchObject({ reason: 'unavailable' });
    },
  );

  it('网络失败 / 非 200 / 非 JSON / 未知过错码 → unavailable（fail-closed）', async () => {
    const cases: Array<typeof fetch> = [
      vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
      vi.fn(async () => jsonResponse({ success: true }, 503)) as unknown as typeof fetch,
      vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
      vi.fn(async () => jsonResponse({ success: false, 'error-codes': ['some-unknown-code'] })) as unknown as typeof fetch,
    ];
    for (const fetchImpl of cases) {
      const captcha = service(fetchImpl);
      await expect(captcha.verify({ token: 'tok' })).rejects.toMatchObject({ reason: 'unavailable' });
    }
  });

  it('空 token 本地拒绝为 invalid，不触达厂商 API', async () => {
    const fetchImpl = vi.fn();
    const captcha = service(fetchImpl as unknown as typeof fetch);
    await expect(captcha.verify({ token: '   ' })).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('captchaFromEnv', () => {
  it('两者都未配置 → null（功能关闭）', () => {
    expect(captchaFromEnv({})).toBeNull();
    expect(captchaFromEnv({ CAPTCHA_SITE_KEY: '', CAPTCHA_SECRET_KEY: '' })).toBeNull();
  });

  it('成对配置 → 服务对象携带 siteKey', () => {
    const captcha = captchaFromEnv({ CAPTCHA_SITE_KEY: 'pk', CAPTCHA_SECRET_KEY: 'sk' });
    expect(captcha).not.toBeNull();
    expect(captcha!.siteKey).toBe('pk');
  });

  it('只配置一半 → 抛错（fail fast，安全控制不许静默半开）', () => {
    expect(() => captchaFromEnv({ CAPTCHA_SITE_KEY: 'pk' })).toThrow();
    expect(() => captchaFromEnv({ CAPTCHA_SECRET_KEY: 'sk' })).toThrow();
  });
});
