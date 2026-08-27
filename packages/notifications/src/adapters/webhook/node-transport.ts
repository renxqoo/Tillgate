/**
 * webhook 守卫拨号传输（node:http/https）：
 * SSRF 校验的钉子挂在自定义 lookup——DNS 解析结果逐地址过 guard.assertAddress 后
 * 才交给连接器。校验的地址 = 实际拨号地址（DNS rebinding 的「过检解析/实连解析」
 * 两次解析窗口结构性消除——fetch 内部独立二次解析不再存在）。
 * 3x 不自动跟随（node 原生不跟 redirect——过审地址可 30x 跳内网，语义与旧
 * fetch redirect:'manual' 一致：3x 即失败，下轮重试）。
 * 超时双保险：req.setTimeout 只覆盖「已连接后的 socket 空闲」（Bun 下 DNS/建连
 * 阶段不触发）；总 deadline 定时器覆盖全程（含解析/建连/慢滴响应），到点销毁请求。
 * 网络异常/超时收敛为 { ok:false, status:0 }（deliverer 端口契约：布尔不抛）；
 * resolve 幂等（end/close/error/总超时四路都可能先到）。
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
 * lookup 在连接阶段触发（请求对象已存在,经 pendingRef 引用）——校验拒绝/解析失败/
 * 空地址表时显式销毁请求:仅靠 lookup callback 的 err 形参传播在 Bun 不保证。
 * 成功路径的 callback 在 try 外调用（回调自身抛错不得落入 catch 造成二次回调）。
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
      let addresses: LookupAddress[];
      try {
        addresses = (await lookup(hostname, { all: true, verbatim: true })) as LookupAddress[];
        for (const entry of addresses) {
          guard.assertAddress(entry.address, { allowLocal });
        }
        if (addresses.length === 0) {
          // 空地址表不得回填占位地址（'0.0.0.0' 在 Linux 即回环——绕过守卫）
          throw new Error(`no addresses resolved for ${hostname}`);
        }
      } catch (error) {
        pendingRef.current?.destroy(error as Error);
        callback(error as Error, options.all === true ? [] : '');
        return;
      }
      // 回填形态按运行时请求：all:true 数组形（Bun 实测）；否则首地址 + family
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses;
      if (first != null) callback(null, first.address, first.family);
    })();
  };
}

/** 守卫拨号传输工厂（deliverer 缺省注入；测试可注入替身传输） */
export function createGuardedNodeTransport(guard: UrlGuard, allowLocal: boolean): GuardedHttpPost {
  return (input) =>
    new Promise((resolve) => {
      const lib = input.url.protocol === 'https:' ? https : http;
      const settled = { done: false };
      const settle = (value: { ok: boolean; status: number }) => {
        if (settled.done) return;
        settled.done = true;
        clearTimeout(deadline);
        resolve(value);
      };
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
          const ok = status >= 200 && status < 300;
          res.resume(); // 丢弃响应体（deliverer 只关心 ok）
          // end=正常读完；close=异常中断（Bun 下 RST 可能只触发 close 不触发 error）
          res.on('end', () => settle({ ok, status }));
          res.on('close', () => settle({ ok, status }));
        },
      );
      pendingRef.current = req;
      // 总 deadline：覆盖 DNS/建连/慢滴响应全程（req.setTimeout 只是空闲超时）
      const deadline = setTimeout(() => {
        req.destroy(new Error('webhook post deadline exceeded'));
      }, input.timeoutMs);
      deadline.unref?.();
      req.setTimeout(input.timeoutMs, () => {
        req.destroy(new Error('webhook post timeout'));
      });
      req.on('close', () => settle({ ok: false, status: 0 }));
      req.on('error', () => settle({ ok: false, status: 0 }));
      req.end(input.body);
    });
}
