/**
 * DNS 解析后校验（防 rebinding）：vi.mock 掉 node:dns/promises ——
 * 域名 → 私网地址拒绝、解析失败降级放行、公网解析放行。
 * 本文件独占该 mock，不与其他传输测试混跑。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'private-v4.test') return [{ address: '10.0.0.5', family: 4 }];
    if (host === 'private-v6.test') return [{ address: 'fd00::1', family: 6 }];
    if (host === 'public.test') {
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '1.1.1.1', family: 4 },
      ];
    }
    throw new Error('ENOTFOUND');
  }),
}));

import { assertSafeUrl } from '../src/transport/http-client.js';

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
  it('公网解析（多地址全公网）→ 放行（机械基线不枚举 hostname——ADR-0010）', async () => {
    await expect(assertSafeUrl('https://public.test/x')).resolves.toBeInstanceOf(URL);
  });
});
