/**
 * 红测（审计问题 #3：IPv6 判定边缘形态缺口）：
 * isUnsafeIpv6 只解包 `::ffff:` IPv4-mapped 形；以下内嵌私网/回环 IPv4 的
 * 形态全部漏判（WHATWG URL 会把 IPv6 规范化，dotted 形进不去、压缩形才到
 * 判定函数——运行时已核实各形态经 assertSafeUrlSync 全放行）：
 *   - IPv4-compatible：`::127.0.0.1`（URL 规范化为 `[::7f00:1]`，= 回环）
 *   - IPv4-compatible 压缩形：`::a00:1`（= 10.0.0.1 私网）
 *   - 6to4 隧道：`2002:a00:1::`（内嵌 10.0.0.1，经 6to4 网关可达私网段）
 * 契约：内嵌 IPv4 部分命中保留段的 IPv6 必须整体拒绝。本文件当前为红，
 * 修复后转绿。
 */
import { describe, expect, it } from 'vitest';
import { assertSafeUrlSync } from '../src/transport/http-client.js';

describe('assertSafeUrlSync IPv6 边缘形态', () => {
  it.each([
    ['https://[::127.0.0.1]/x', 'IPv4-compatible dotted 回环（URL 规范化为 ::7f00:1）'],
    ['https://[::7f00:1]/x', 'IPv4-compatible 压缩形回环'],
    ['https://[::a00:1]/x', 'IPv4-compatible 压缩形私网 10.0.0.1'],
    ['https://[2002:a00:1::]/x', '6to4 内嵌私网 10.0.0.1'],
  ])('%s 必须整体拒绝（%s）', (url) => {
    expect(() => assertSafeUrlSync(url)).toThrow(/blocked address/);
  });
});
