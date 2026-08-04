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
  const safe = ['8.8.8.8', '1.1.1.1', '114.114.114.114', '172.15.255.255', '100.63.0.1', '223.5.5.5'];

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

  it('allowedHosts 白名单跳过 DNS 判定', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(
      assertSafeUrl('https://internal.example.com/v1', { allowedHosts: ['internal.example.com'] }),
    ).resolves.toBeTruthy();
  });

  it('DNS 解析失败放行（fetch 自然报 network 错误）', async () => {
    mockedLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('https://no-such-host.invalid/v1')).resolves.toBeTruthy();
  });
});
