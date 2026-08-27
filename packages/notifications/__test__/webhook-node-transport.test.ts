/**
 * 守卫拨号传输（node:http + 拨号层 lookup 钉子）：
 * S2 的核心契约——SSRF 校验挂在「实际发起连接的解析钩子」上：
 *   - DNS 解析结果逐地址过 guard.assertAddress,校验的就是拨号地址本身
 *     （DNS rebinding 的「过检解析/实连解析」两次解析窗口结构性消除）；
 *   - 域名拨到被 mock 的解析地址（证明连接用的是校验过的地址,而非二次解析）;
 *   - 校验拒绝 → 不发起连接（服务端零命中）。
 * node:dns/promises 独占 mock,不与其他传输测试混跑。
 */
import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGuardedNodeTransport } from '../src/adapters/webhook/node-transport';
import type { UrlGuard } from '../src/ports/url-guard';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'rebind.test') return [{ address: '127.0.0.1', family: 4 }];
    if (host === 'rebind-multi.test') {
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ];
    }
    throw new Error('ENOTFOUND');
  }),
}));

/** 本地回声服务:命中即记（证明连接实际到达的是解析钉住的地址） */
async function echoServer() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url} host=${req.headers.host} body=${body}`);
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    hits,
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  };
}

function guardOf(reject?: (address: string) => boolean): UrlGuard & { checked: string[] } {
  const checked: string[] = [];
  return {
    async assert(url) {
      return new URL(url);
    },
    assertAddress: (address) => {
      checked.push(address);
      if (reject?.(address)) throw new Error(`blocked address: ${address}`);
    },
    checked,
  };
}

describe('createGuardedNodeTransport（拨号层 SSRF 钉子）', () => {
  it('域名拨号用「已校验的解析地址」——请求实达 mock 解析指向的本地服务', async () => {
    const server = await echoServer();
    try {
      const guard = guardOf();
      const transport = createGuardedNodeTransport(guard, true);
      const res = await transport({
        url: new URL(`http://rebind.test:${server.port}/hook`),
        headers: { 'content-type': 'application/json', 'x-test': '1' },
        body: '{"a":1}',
        timeoutMs: 2_000,
      });
      expect(res).toEqual({ ok: true, status: 200 });
      // 连接到达本地回声服务（DNS 被 mock——实连地址只能是 lookup 返回并校验过的）
      expect(server.hits).toEqual([`POST /hook host=rebind.test:${server.port} body={"a":1}`]);
      expect(guard.checked).toEqual(['127.0.0.1']);
    } finally {
      server.close();
    }
  });

  it('多地址解析:任一地址被拒 → 不发起连接（服务端零命中,ok=false）', async () => {
    const server = await echoServer();
    try {
      const guard = guardOf((address) => address === '10.0.0.5');
      const transport = createGuardedNodeTransport(guard, false);
      const res = await transport({
        url: new URL(`https://rebind-multi.test:${server.port}/hook`),
        headers: {},
        body: '{}',
        timeoutMs: 2_000,
      });
      expect(res.ok).toBe(false);
      expect(guard.checked).toEqual(['93.184.216.34', '10.0.0.5']); // 逐地址判定
      expect(server.hits).toEqual([]); // 拒绝后从未拨号
    } finally {
      server.close();
    }
  });

  it('allowLocal=false 时守卫拒绝回环 → 不拨号（rebinding 实连内网被挡）', async () => {
    const server = await echoServer();
    try {
      const guard = guardOf((address) => address === '127.0.0.1');
      const transport = createGuardedNodeTransport(guard, false);
      const res = await transport({
        url: new URL(`http://rebind.test:${server.port}/hook`),
        headers: {},
        body: '{}',
        timeoutMs: 2_000,
      });
      expect(res.ok).toBe(false);
      expect(server.hits).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('连接失败（校验通过但目标不可达）→ { ok:false, status:0 } 不抛', async () => {
    const guard = guardOf();
    const transport = createGuardedNodeTransport(guard, true);
    const res = await transport({
      url: new URL('http://rebind.test:1/unreachable'),
      headers: {},
      body: '{}',
      timeoutMs: 500,
    });
    expect(res).toEqual({ ok: false, status: 0 });
  });
});
