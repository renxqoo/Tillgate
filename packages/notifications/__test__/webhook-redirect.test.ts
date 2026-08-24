/**
 * 红测（审计问题 #2：webhook 投递跟随重定向且不复检目标）：
 * guard.assert 只校验初始 URL；deliver 的 fetch 缺省 redirect:'follow'，
 * 一个过审的 https 公网 webhook 地址可 302/307/308 跳到
 * http://127.0.0.1:xxxx、http://169.254.169.254/（307/308 还保留 POST 体，
 * 可产生内网写副作用），同时绕过 https-only 与私网判定。
 * 契约：webhook POST 必须以 redirect:'manual' 派发。本文件当前为红，
 * 修复后转绿。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookDeliverer } from '../src/adapters/webhook/http-deliverer';
import type { UrlGuard } from '../src/ports/url-guard';
import { defined } from './defined';

afterEach(() => vi.unstubAllGlobals());

const permissive: UrlGuard = {
  async assert(url) {
    return new URL(url);
  },
};

describe('webhook deliverer 重定向防护', () => {
  it('POST 必须以 redirect:"manual" 派发（守卫不得被 30x 跳转绕过）', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return new Response('ok', { status: 200 });
      }),
    );
    const deliverer = createWebhookDeliverer({
      guard: permissive,
      timeoutMs: 1_000,
      allowLocal: false,
      logger: { warn: () => {} },
    });
    const ok = await deliverer.deliver({
      url: 'https://hooks.example.test/h',
      secret: 'whsec-test',
      event: 'billing_dead',
      payload: { requestId: 'r1' },
      deliveryId: '9:11',
    });
    expect(ok).toBe(true);
    expect(inits).toHaveLength(1);
    expect(defined(inits[0], 'inits[0]').redirect).toBe('manual');
  });
});
