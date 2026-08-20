/**
 * webhook SSRF 硬门回归（2026-08-19 终审修复）：管理员配置的 webhook URL
 * 不得成为内网/metadata 探测跳板——投递前过 assertSafeUrl（https-only +
 * 私网/回环全拒 + DNS 逐地址判定），拒绝即该渠道投递失败（fail-closed）。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { deliver } from '../tasks/notify-dispatch.js';
import { encrypt } from '@ai-gateway/core';

const logger = { warn: (_obj: unknown, _msg: string) => {} };
const encryptionKey = 'notify-test-encryption-key-32chars!';
const encryptedSecret = encrypt('x', encryptionKey);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('webhook SSRF 硬门', () => {
  it('明文 http / 私网 / 回环 / metadata 地址 → 拒投且不发起 fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const blocked = [
      'http://169.254.169.254/latest/meta-data', // 云 metadata
      'http://10.0.0.5/hook', // 私网 A 段
      'http://192.168.1.10/hook', // 私网 C 段
      'http://localhost:9000/hook', // 回环域名
      'http://127.0.0.1:8080/hook', // 回环地址
    ];
    for (const url of blocked) {
      const ok = await deliver(1, 'webhook', { url, secret: 'x' }, 'balance_low', {}, logger);
      expect(ok, url).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('https 公网地址 → 放行到 fetch（正常投递不受影响）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const ok = await deliver(
      1, 'webhook', { url: 'https://example.com/hook', secret: encryptedSecret }, 'balance_low', {}, logger,
      undefined, { encryptionKey },
    );
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('dev 逃生门（allowLocal）：http 回环放行——生产由 env 双门（&& NODE_ENV!==production）恒 false 锁死', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const ok = await deliver(
      1, 'webhook', { url: 'http://localhost:9000/hook', secret: encryptedSecret }, 'evt', {}, logger,
      undefined, { webhookAllowLocalUrl: true, encryptionKey },
    );
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('公网 webhook 的明文 secret 也拒绝投递', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const ok = await deliver(
      1, 'webhook', { url: 'https://example.com/hook', secret: 'plaintext' }, 'evt', {}, logger,
      undefined, { encryptionKey },
    );
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
