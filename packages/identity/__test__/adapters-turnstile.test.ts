/**
 * Turnstile 适配器测试(v1 captcha.test 迁移,注入 fetch):请求形状、
 * 客户端过错/服务端过错分级、网络失败、空 token 本地拒、captcha 用例翻译。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTurnstileCaptcha } from '../src/adapters/turnstile/captcha.js';
import { createTestHarness } from '../src/testing/harness.js';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch;
}

const OPTS = { siteKey: 'site-key', secretKey: 'secret-key', timeoutMs: 5_000 };

describe('turnstile 适配器(fail-closed 语义分级)', () => {
  it('成功:POST + form 编码 + secret/response/remoteip 三字段', async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      expect(init?.method).toBe('POST');
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('secret')).toBe('secret-key');
      expect(body.get('response')).toBe('tok-1');
      expect(body.get('remoteip')).toBe('203.0.113.1');
      return Response.json({ success: true });
    });
    const captcha = createTurnstileCaptcha({ ...OPTS, fetchImpl });
    await expect(captcha.verify({ token: ' tok-1 ', remoteIp: '203.0.113.1' })).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    'missing-input-response',
    'invalid-input-response',
    'timeout-or-duplicate',
    'invalid-or-already-seen-response',
  ])('客户端过错码 %s → invalid', async (code) => {
    const captcha = createTurnstileCaptcha({
      ...OPTS,
      fetchImpl: fakeFetch(() => Response.json({ success: false, 'error-codes': [code] })),
    });
    await expect(captcha.verify({ token: 't' })).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['空码表', { success: false }],
    ['未知码', { success: false, 'error-codes': ['something-odd'] }],
    ['配置过错', { success: false, 'error-codes': ['invalid-input-secret'] }],
  ])('%s → unavailable(fail-closed)', async (_name, body) => {
    const captcha = createTurnstileCaptcha({
      ...OPTS,
      fetchImpl: fakeFetch(() => Response.json(body)),
    });
    await expect(captcha.verify({ token: 't' })).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('网络失败/非 200/非 JSON → unavailable;空 token 本地拒且不触网', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('network down');
    });
    const captcha = createTurnstileCaptcha({ ...OPTS, fetchImpl });
    await expect(captcha.verify({ token: 't' })).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });

    const notOk = createTurnstileCaptcha({
      ...OPTS,
      fetchImpl: fakeFetch(() => new Response('boom', { status: 500 })),
    });
    await expect(notOk.verify({ token: 't' })).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });

    const badJson = createTurnstileCaptcha({
      ...OPTS,
      fetchImpl: fakeFetch(() => new Response('<html>not json</html>', { status: 200 })),
    });
    await expect(badJson.verify({ token: 't' })).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });

    const local = createTurnstileCaptcha({ ...OPTS, fetchImpl });
    await expect(local.verify({ token: '   ' })).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 仅网络失败那一次;空 token 未触网
  });
});

describe('captcha 用例翻译(facade 面)', () => {
  it('invalid/unavailable 二分映射到错误目录;未装配 → captcha_unavailable', async () => {
    const h = createTestHarness();
    h.captcha.next = { ok: true };
    await expect(h.api.captcha.verify({ token: 't' })).resolves.toEqual({ ok: true });
    h.captcha.next = { ok: false, reason: 'invalid' };
    await expect(h.api.captcha.verify({ token: 't' })).rejects.toMatchObject({
      code: 'identity.captcha_invalid',
    });
    h.captcha.next = { ok: false, reason: 'unavailable' };
    await expect(h.api.captcha.verify({ token: 't' })).rejects.toMatchObject({
      code: 'identity.captcha_unavailable',
    });

    const { createIdentity } = await import('../src/identity.js');
    const { TEST_CONFIG } = await import('../src/testing/harness.js');
    const bare = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => {} },
      config: TEST_CONFIG,
      store: h.store,
    });
    await expect(bare.captcha.verify({ token: 't' })).rejects.toMatchObject({
      code: 'identity.captcha_unavailable',
    });
  });
});
