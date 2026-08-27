/**
 * 重定向防护（审计问题 #2 历史红测的传输面续篇）：
 * 守卫拨号传输基于 node:http/https——原生不跟随重定向，3x 状态码按投递失败
 * 处理（过审地址可 302/307/308 跳内网/metadata，307/308 还保留 POST 体）。
 * 契约：3x 响应 → deliver false（下轮重试），绝不向 Location 发起第二次请求。
 */
import { describe, expect, it } from 'vitest';
import { createWebhookDeliverer } from '../src/adapters/webhook/http-deliverer';
import type { GuardedHttpPost } from '../src/adapters/webhook/node-transport';
import type { UrlGuard } from '../src/ports/url-guard';

const permissive: UrlGuard = {
  async assert(url) {
    return new URL(url);
  },
  assertAddress: () => {},
};

describe('webhook deliverer 重定向防护', () => {
  it.each([301, 302, 307, 308])('3x（%s）视为投递失败——不跟随 Location', async (status) => {
    let attempts = 0;
    const transport: GuardedHttpPost = async () => {
      attempts += 1;
      return { ok: false, status };
    };
    const deliverer = createWebhookDeliverer({
      guard: permissive,
      timeoutMs: 1_000,
      allowLocal: false,
      logger: { warn: () => {} },
      transport,
    });
    const ok = await deliverer.deliver({
      url: 'https://hooks.example.test/h',
      secret: 'whsec-test',
      event: 'billing_dead',
      payload: { requestId: 'r1' },
      deliveryId: '9:11',
    });
    expect(ok).toBe(false);
    expect(attempts).toBe(1); // 只对初始 URL 发一次,无第二次请求
  });
});
