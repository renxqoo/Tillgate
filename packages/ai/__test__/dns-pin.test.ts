/**
 * DNS 解析后校验（防 rebinding）与 resolveAndPin：
 * vi.mock 掉 node:dns/promises —— 域名 → 私网地址拒绝、解析失败降级放行、
 * 公网地址 pin 返回首地址与端口推导。本文件独占该 mock，不与其他传输测试混跑。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'private-v4.test') return [{ address: '10.0.0.5', family: 4 }];
    if (host === 'private-v6.test') return [{ address: 'fd00::1', family: 6 }];
    if (host === 'public.test')
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '1.1.1.1', family: 4 },
      ];
    throw new Error('ENOTFOUND');
  }),
}));

import { assertSafeUrl, resolveAndPin } from '../src/transport/http-client.js';

describe('assertSafeUrl：DNS 解析后逐地址判定', () => {
  it('域名解析到私网 v4/v6 → 拒绝（防 rebinding）', async () => {
    await expect(assertSafeUrl('https://private-v4.test/x')).rejects.toThrow(
      /resolves to 10\.0\.0\.5/,
    );
    await expect(assertSafeUrl('https://private-v6.test/x')).rejects.toThrow(/resolves to fd00::1/);
  });
  it('解析失败 → 放行（交给 fetch 自然报 network，未解析=无法连接）', async () => {
    await expect(assertSafeUrl('https://nxdomain.test/x')).resolves.toBeInstanceOf(URL);
  });
});

describe('resolveAndPin：受信 host 校验 + pin 结果', () => {
  it('私网解析拒绝；解析失败降级 ip=null', async () => {
    await expect(resolveAndPin('https://private-v4.test/x')).rejects.toThrow(/resolves to/);
    const miss = await resolveAndPin('https://nxdomain.test/x');
    expect(miss).toEqual({ ip: null, hostname: 'nxdomain.test', port: 443 });
  });
  it('公网解析 → pin 首地址；端口推导 443/80/显式', async () => {
    const pinned = await resolveAndPin('https://public.test/x');
    expect(pinned).toEqual({ ip: '93.184.216.34', hostname: 'public.test', port: 443 });
    const withPort = await resolveAndPin('https://public.test:8443/x');
    expect(withPort.port).toBe(8443);
    const http = await resolveAndPin('http://public.test/x', { allowLocal: true });
    expect(http).toEqual({ ip: null, hostname: 'public.test', port: 80 }); // allowLocal 跳过校验
  });
  it('白名单外 host → 拒绝（allowlist 是生产主防线）', async () => {
    await expect(
      resolveAndPin('https://public.test/x', { allowedHosts: ['other.test'] }),
    ).rejects.toThrow(/not allowlisted/);
  });
});
