/**
 * webhook 守卫拨号传输（node:http/https）：
 * SSRF 校验的钉子挂在自定义 lookup——DNS 解析结果逐地址过 guard.assertAddress 后
 * 才交给连接器。校验的地址 = 实际拨号地址（DNS rebinding 的「过检解析/实连解析」
 * 两次解析窗口结构性消除——fetch 内部独立二次解析不再存在）。
 * 3x 不自动跟随（node 原生不跟 redirect——过审地址可 30x 跳内网，语义与旧
 * fetch redirect:'manual' 一致：3x 即失败，下轮重试）。
 * 网络异常/超时收敛为 { ok:false, status:0 }（deliverer 端口契约：布尔不抛）。
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { UrlGuard } from '../../ports/url-guard';

export interface GuardedHttpPost {
  (input: {
    url: URL;
    headers: Readonly<Record<string, string>>;
    body: string;
    timeoutMs: number;
  }): Promise<{ ok: boolean; status: number }>;
}

/**
 * 自定义 lookup 工厂：解析 → 逐地址断言 → 校验过的地址交给连接器。
 * lookup 在连接阶段触发（请求对象已存在,经 pendingRef 引用）——校验拒绝时
 * 显式销毁请求:仅靠 lookup callback 的 err 形参传播在 Bun 不保证（挂起而非报错）。
 */
function guardedLookupOf(
  guard: UrlGuard,
  allowLocal: boolean,
  pendingRef: { current?: http.ClientRequest },
) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (err: Error | null, address: unknown, family?: number) => void,
  ) => {
    void (async () => {
      try {
        const addresses = (await lookup(hostname, {
          all: true,
          verbatim: true,
        })) as LookupAddress[];
        for (const entry of addresses) {
          guard.assertAddress(entry.address, { allowLocal });
        }
        // 回填形态按运行时请求：all:true 数组形（Bun 实测）；否则首地址 + family
        if (options.all === true) {
          callback(null, addresses);
          return;
        }
        const [first] = addresses;
        callback(null, first?.address ?? '0.0.0.0', first?.family ?? 4);
      } catch (error) {
        pendingRef.current?.destroy(error as Error);
        callback(error as Error, options.all === true ? [] : '');
      }
    })();
  };
}

/** 守卫拨号传输工厂（deliverer 缺省注入；测试可注入替身传输） */
export function createGuardedNodeTransport(guard: UrlGuard, allowLocal: boolean): GuardedHttpPost {
  return (input) =>
    new Promise((resolve) => {
      const lib = input.url.protocol === 'https:' ? https : http;
      const pendingRef: { current?: http.ClientRequest } = {};
      const guardedLookup = guardedLookupOf(guard, allowLocal, pendingRef);
      const req = lib.request(
        {
          protocol: input.url.protocol,
          hostname: input.url.hostname,
          port: input.url.port || (input.url.protocol === 'https:' ? 443 : 80),
          path: `${input.url.pathname}${input.url.search}`,
          method: 'POST',
          headers: input.headers,
          lookup: guardedLookup as never,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume(); // 丢弃响应体（deliverer 只关心 ok）
          res.on('end', () => resolve({ ok: status >= 200 && status < 300, status }));
        },
      );
      pendingRef.current = req;
      req.setTimeout(input.timeoutMs, () => {
        req.destroy(new Error('webhook post timeout'));
      });
      req.on('error', () => resolve({ ok: false, status: 0 }));
      req.end(input.body);
    });
}
