import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

// lookup 有多个重载（单个/全部地址），mocked 类型收敛到集成测试用到的形态。
// 注：mockRejectedValue/Promise.reject 在 vitest 4.1.10 对 node: 内置模块 mock 有 unhandled rejection 误报，
// 因此 reject 场景统一用 mockRejectedValueOnce（每次测试恰好一次调用）。
const mockedLookup = vi.mocked(lookup) as unknown as {
  mockResolvedValue: (v: Array<{ address: string; family: number }>) => void;
  mockRejectedValueOnce: (v: unknown) => void;
  mockReset: () => void;
};

import {
  assertSafeUrl,
  assertSafeUrlSync,
  isUnsafeIpv4,
  isUnsafeIpv6,
} from '../../src/transport/http-client.js';

describe('isUnsafeIpv4', () => {
  const unsafe = [
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '127.0.0.1',
    '127.8.8.8',
    '169.254.169.254', // 云 metadata
    '169.254.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '100.64.0.1', // CGNAT
    '100.127.255.255',
    '224.0.0.1', // 组播
    '255.255.255.255',
    'not-an-ip',
    '1.2.3',
  ];
  const safe = [
    '8.8.8.8',
    '1.1.1.1',
    '114.114.114.114',
    '172.15.255.255',
    '100.63.0.1',
    '223.5.5.5',
  ];

  it('拒绝内网/保留段，放行公网', () => {
    for (const ip of unsafe) expect(isUnsafeIpv4(ip), ip).toBe(true);
    for (const ip of safe) expect(isUnsafeIpv4(ip), ip).toBe(false);
  });
});

describe('isUnsafeIpv6', () => {
  const unsafe = ['::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1'];
  const safe = ['2001:4860:4860::8888', '2606:4700:4700::1111', '2400:3200::1'];

  it('拒绝未指定/回环/ULA/链路本地/组播，放行公网', () => {
    for (const ip of unsafe) expect(isUnsafeIpv6(ip), ip).toBe(true);
    for (const ip of safe) expect(isUnsafeIpv6(ip), ip).toBe(false);
  });
});

describe('assertSafeUrlSync', () => {
  it('拒绝非 https 协议', () => {
    expect(() => assertSafeUrlSync('http://api.deepseek.com/v1')).toThrow(
      'unsupported protocol: http:',
    );
  });

  it('allowLocal 时允许 http', () => {
    const u = assertSafeUrlSync('http://127.0.0.1:8080/v1', { allowLocal: true });
    expect(u.hostname).toBe('127.0.0.1');
  });

  it('拒绝字面量内网 IP（https 也不行）', () => {
    expect(() => assertSafeUrlSync('https://127.0.0.1/v1')).toThrow('blocked address');
    expect(() => assertSafeUrlSync('https://10.1.2.3/v1')).toThrow('blocked address');
    expect(() => assertSafeUrlSync('https://[::1]/v1')).toThrow('blocked address');
    expect(() => assertSafeUrlSync('https://[fd00::1]/v1')).toThrow('blocked address');
  });

  it('拒绝 localhost 主机名', () => {
    expect(() => assertSafeUrlSync('https://localhost/v1')).toThrow('blocked host');
  });

  it('公网域名与公网 IP 字面量通过', () => {
    expect(assertSafeUrlSync('https://api.deepseek.com/v1').hostname).toBe('api.deepseek.com');
    expect(assertSafeUrlSync('https://8.8.8.8/v1').hostname).toBe('8.8.8.8');
  });

  it('畸形 URL 报 TypeError', () => {
    expect(() => assertSafeUrlSync('not a url')).toThrow(TypeError);
  });
});

describe('assertSafeUrl（含 DNS 判定，防 rebinding）', () => {
  beforeEach(() => mockedLookup.mockReset());

  it('域名解析到内网地址则拒绝', async () => {
    mockedLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(assertSafeUrl('https://evil.example.com/v1')).rejects.toThrow(
      'resolves to 127.0.0.1',
    );
  });

  it('域名解析到混合地址（含内网）也拒绝', async () => {
    mockedLookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    await expect(assertSafeUrl('https://evil.example.com/v1')).rejects.toThrow('blocked address');
  });

  it('域名解析全部公网则通过', async () => {
    mockedLookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ]);
    await expect(assertSafeUrl('https://evil.example.com/v1')).resolves.toBeTruthy();
  });

  it('allowedHosts 仍执行 DNS 私网判定', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(
      assertSafeUrl('https://internal.example.com/v1', { allowedHosts: ['internal.example.com'] }),
    ).rejects.toThrow('blocked address');
  });

  it('配置白名单时拒绝白名单外域名', async () => {
    await expect(
      assertSafeUrl('https://evil.example.com/v1', { allowedHosts: ['api.example.com'] }),
    ).rejects.toThrow('not allowlisted');
  });

  it('DNS 解析失败放行（fetch 自然报 network 错误）', async () => {
    mockedLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('https://no-such-host.invalid/v1')).resolves.toBeTruthy();
  });
});

describe('isUnsafeIpv6 — IPv4-mapped IPv6 绕过防护', () => {
  // 审计发现：::ffff:169.254.169.254 等 IPv4-mapped IPv6 可绕过内网判定
  it('IPv4-mapped IPv6 内网地址被拦截（::ffff:169.254.169.254）', () => {
    expect(isUnsafeIpv6('::ffff:169.254.169.254')).toBe(true);
    expect(isUnsafeIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(isUnsafeIpv6('::ffff:10.0.0.1')).toBe(true);
    expect(isUnsafeIpv6('::ffff:192.168.1.1')).toBe(true);
  });

  it('IPv4-mapped 公网地址通过（::ffff:8.8.8.8）', () => {
    expect(isUnsafeIpv6('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('resolveAndPin（受信 host + DNS 地址校验）', () => {
  beforeEach(() => mockedLookup.mockReset());

  it('返回校验后的 IP + 原始 hostname（供诊断与策略记录）', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const { resolveAndPin } = await import('../../src/transport/http-client.js');
    const result = await resolveAndPin('https://api.example.com/v1');
    expect(result.ip).toBe('93.184.216.34');
    expect(result.hostname).toBe('api.example.com');
    expect(result.port).toBe(443);
  });

  it('解析到内网地址 → 拒绝（与 assertSafeUrl 一致）', async () => {
    mockedLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const { resolveAndPin } = await import('../../src/transport/http-client.js');
    await expect(resolveAndPin('https://evil.example.com/v1')).rejects.toThrow('blocked address');
  });

  it('DNS 解析失败 → 返回 null IP（降级用原始 URL，fetch 自然报 network 错误）', async () => {
    mockedLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const { resolveAndPin } = await import('../../src/transport/http-client.js');
    const result = await resolveAndPin('https://no-such-host.invalid/v1');
    expect(result.ip).toBeNull();
    expect(result.hostname).toBe('no-such-host.invalid');
  });

  it('allowLocal → 跳过校验直接返回 null IP', async () => {
    const { resolveAndPin } = await import('../../src/transport/http-client.js');
    const result = await resolveAndPin('http://127.0.0.1:3000/v1', { allowLocal: true });
    expect(result.ip).toBeNull();
    expect(result.hostname).toBe('127.0.0.1');
    expect(result.port).toBe(3000);
  });
});
