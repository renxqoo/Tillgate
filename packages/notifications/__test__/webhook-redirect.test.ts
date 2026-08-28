/**
 * 重定向防护（真实拨号验证）：守卫拨号传输基于 node:http——本用例起本地
 * 302 服务 + 第二端点（私网形态目标），走缺省 transport（非替身）断言
 * 「绝不向 Location 发起第二次请求」（3x 即失败，下轮重试）。
 */
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWebhookDeliverer } from '../src/adapters/webhook/http-deliverer';
import type { UrlGuard } from '../src/ports/url-guard';

const permissive: UrlGuard = {
  async assert(url) {
    return new URL(url);
  },
  assertAddress: () => {},
};

describe('webhook deliverer 重定向防护', () => {
  it.each([301, 302, 307, 308])('3x（%s）不跟随 Location——第二端点零命中', async (status) => {
    // 第二端点（Location 目标——若跟随即命中并留下记录）
    let secondHits = 0;
    const second = http.createServer((req, res) => {
      void req;
      secondHits += 1;
      res.writeHead(200);
      res.end('evil');
    });
    await new Promise<void>((resolve) => {
      second.listen(0, '127.0.0.1', () => resolve());
    });
    // 初始端点：回 3x + Location 指向第二端点
    const first = http.createServer((req, res) => {
      void req;
      const { port } = second.address() as AddressInfo;
      res.writeHead(status, { location: `http://127.0.0.1:${port}/evil` });
      res.end();
    });
    await new Promise<void>((resolve) => {
      first.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const deliverer = createWebhookDeliverer({
        guard: permissive,
        timeoutMs: 2_000,
        allowLocal: true, // 本地回环目标（dev 双门语义；3x 语义与生产一致）
        logger: { warn: () => {} },
        // 不注 transport——走缺省守卫拨号传输（node:http 真实行为）
      });
      const { port } = first.address() as AddressInfo;
      const ok = await deliverer.deliver({
        url: `http://127.0.0.1:${port}/hook`,
        secret: 'whsec-test',
        event: 'billing_dead',
        payload: { requestId: 'r1' },
        deliveryId: '9:11',
      });
      expect(ok).toBe(false); // 3x = 投递失败（可重试）
      expect(secondHits).toBe(0); // 绝不向 Location 发起第二次请求
    } finally {
      first.close();
      second.close();
    }
  });
});
